import { Zip, ZipPassThrough } from 'fflate';
import { decodeDesign } from './design';
import { ResumableUpload, type DriveFile } from './drive';
import { download, slug, type ExportFormat } from './export';
import { normalizeHex, primaryColorLayer, type Edits } from './layers';
import { renderer, type FitMode } from './render';
import type { DesignItem } from './useDesigns';
import type { MockupRecord } from './types';

export interface BulkSettings {
  mockupIds: string[];
  /** Free text: HEX values separated by commas, spaces or new lines. */
  hexText: string;
  includeOriginal: boolean;
  designIds: number[];
  format: ExportFormat;
  /** Longest edge in px; 0 = each mockup's original size. */
  longEdge: number;
  groupByDesign: boolean;
  destination: 'device' | 'drive';
  /** Ids already offered for selection, so a mockup or design the user unticked doesn't re-select itself. */
  knownMockups: string[];
  knownDesigns: number[];
}

export const defaultBulkSettings = (): BulkSettings => ({
  destination: 'device',
  knownMockups: [],
  knownDesigns: [],
  mockupIds: [],
  hexText: '',
  includeOriginal: false,
  designIds: [],
  format: 'png',
  longEdge: 0,
  groupByDesign: true,
});

export const MAX_BULK_IMAGES = 1000;

export interface BulkJob {
  mockup: MockupRecord;
  design: DesignItem;
  /** null = the mockup's own color. */
  color: string | null;
  /** Path inside the zip. */
  path: string;
}

export interface BulkPlan {
  jobs: BulkJob[];
  notes: string[];
}

/** Mockup-major, then design, then color: that order keeps one mockup's textures hot on the GPU. */
export function planJobs(
  mockups: MockupRecord[],
  designs: DesignItem[],
  colors: string[],
  includeOriginal: boolean,
  format: ExportFormat,
  groupByDesign: boolean,
): BulkPlan {
  const jobs: BulkJob[] = [];
  const notes: string[] = [];
  const used = new Set<string>();
  for (const m of mockups) {
    if (!m.designTargetId) {
      notes.push(`${m.name}: no design area, skipped.`);
      continue;
    }
    const primary = primaryColorLayer(m);
    const variants: (string | null)[] = [];
    if (includeOriginal || colors.length === 0) variants.push(null);
    if (primary) variants.push(...colors.map(normalizeHex).filter((c): c is string => c !== null));
    else if (colors.length) notes.push(`${m.name}: no color layer to recolor, exported once per design.`);
    if (!primary && !variants.length) variants.push(null);
    for (const d of designs) {
      for (const color of variants) {
        const base = `${slug(m.name) || 'mockup'}_${slug(d.name) || 'design'}_${color ? color.slice(1) : 'original'}`;
        const dir = groupByDesign ? `${slug(d.name) || 'design'}/` : '';
        let path = `${dir}${base}.${format}`;
        for (let n = 2; used.has(path); n++) path = `${dir}${base}-${n}.${format}`;
        used.add(path);
        jobs.push({ mockup: m, design: d, color, path });
      }
    }
  }
  return { jobs, notes };
}

export interface ZipSink {
  write(chunk: Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
  readonly mode: 'disk' | 'memory' | 'drive';
  /** Set once a Drive upload has finished. */
  readonly file?: DriveFile;
}

/** Streams the zip into the user's Google Drive as it is produced, so memory stays flat. */
export async function openDriveSink(name: string, onProgress?: (sent: number) => void): Promise<ZipSink> {
  const up = new ResumableUpload(name, 'application/zip', onProgress);
  await up.start();
  let file: DriveFile | undefined;
  return {
    mode: 'drive',
    write: (c) => up.write(c),
    close: async () => {
      file = await up.finish();
    },
    get file() {
      return file;
    },
  };
}

interface SaveHandle {
  createWritable(): Promise<{ write(d: Uint8Array): Promise<void>; close(): Promise<void> }>;
}

/**
 * Where the zip goes. Chrome/Edge can stream straight to a file the user picks, so memory stays flat even for
 * hundreds of images; other browsers collect the zip in memory and download it at the end.
 * Must be called straight from a click: the save dialog needs the user gesture.
 */
export async function openZipSink(suggestedName: string): Promise<ZipSink> {
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<SaveHandle> }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName, types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] });
      const w = await handle.createWritable();
      return { mode: 'disk', write: (c) => w.write(c), close: () => w.close() };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw new Error('Export cancelled: no file was chosen.');
      // Anything else (blocked, unsupported context): fall back to memory.
    }
  }
  const parts: BlobPart[] = [];
  return {
    mode: 'memory',
    write: (c) => void parts.push(c as BlobPart),
    close: () => download(new Blob(parts, { type: 'application/zip' }), suggestedName),
  };
}

export interface BulkProgress {
  done: number;
  total: number;
  current: string;
  failed: number;
  etaMs?: number;
}

export interface BulkResult {
  done: number;
  failed: { path: string; error: string }[];
  cancelled: boolean;
  bytes: number;
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' } as const;
const csv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export async function runBulk(opts: {
  jobs: BulkJob[];
  editsMap: Record<string, Edits>;
  format: ExportFormat;
  longEdge: number;
  fit: FitMode;
  sink: ZipSink;
  signal: AbortSignal;
  onProgress: (p: BulkProgress) => void;
}): Promise<BulkResult> {
  const { jobs, editsMap, format, longEdge, fit, sink, signal, onProgress } = opts;
  const enc = new TextEncoder();

  // fflate hands us chunks synchronously; keep writes ordered through one promise chain.
  let chain: Promise<void> = Promise.resolve();
  let sinkError: unknown;
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      sinkError = err;
      return;
    }
    chain = chain.then(() => sink.write(chunk));
    if (final) chain = chain.then(() => sink.close());
  });
  const addFile = (path: string, data: Uint8Array) => {
    // Images are already compressed, so store them as-is.
    const f = new ZipPassThrough(path);
    zip.add(f);
    f.push(data, true);
  };

  const failed: BulkResult['failed'] = [];
  const rows: string[] = ['file,mockup,design,color,status'];
  let done = 0;
  let bytes = 0;
  let cancelled = false;
  let lastMockup: MockupRecord | undefined;
  let lastDesign: number | undefined;
  let bitmap: ImageBitmap | undefined;
  const started = performance.now();

  try {
    for (const job of jobs) {
      if (signal.aborted) {
        cancelled = true;
        break;
      }
      const { mockup, design, color, path } = job;
      onProgress({ done, total: jobs.length, current: path, failed: failed.length, etaMs: done ? ((performance.now() - started) / done) * (jobs.length - done) : undefined });

      if (mockup.id !== lastMockup?.id) {
        if (lastMockup) renderer().forget(lastMockup.id); // free the previous mockup's textures
        lastMockup = mockup;
        lastDesign = undefined;
      }
      const row = (status: string) => rows.push([path, mockup.name, design.name, color ?? 'original', status].map(csv).join(','));
      try {
        if (design.id !== lastDesign) {
          bitmap?.close();
          bitmap = undefined;
          lastDesign = design.id;
          bitmap = await decodeDesign(design.file);
        }
        const base = editsMap[mockup.id];
        let edits = base;
        const primary = primaryColorLayer(mockup);
        if (color && primary) {
          edits = {
            colors: { ...base?.colors, [primary.path]: color },
            visible: { ...base?.visible, [primary.path]: true },
            opacity: { ...base?.opacity },
            designBlend: base?.designBlend,
          };
        }
        const blob = await renderer().render(mockup, {
          maxEdge: longEdge || Math.max(mockup.width, mockup.height),
          design: bitmap ? { bitmap, fit } : null,
          edits,
          cache: true,
          format: MIME[format],
        });
        const data = new Uint8Array(await blob.arrayBuffer());
        addFile(path, data);
        bytes += data.length;
        done++;
        row('ok');
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        failed.push({ path, error });
        row(`failed: ${error}`);
        lastDesign = undefined; // force a clean decode next time
      }
    }
  } finally {
    bitmap?.close();
    if (lastMockup) renderer().forget(lastMockup.id);
  }

  addFile('manifest.csv', enc.encode(rows.join('\n') + '\n'));
  if (failed.length) addFile('errors.txt', enc.encode(failed.map((f) => `${f.path}: ${f.error}`).join('\n') + '\n'));
  zip.end();
  await chain;
  if (sinkError) throw sinkError instanceof Error ? sinkError : new Error(String(sinkError));
  onProgress({ done, total: jobs.length, current: '', failed: failed.length });
  return { done, failed, cancelled, bytes };
}
