import IngestWorker from '../workers/ingest.worker?worker';
import type { IngestMessage, IngestResult } from '../workers/ingest.worker';
import { ACCEPTED_EXT, MAX_FILES, MAX_RAW_BYTES, MAX_STORED_BYTES, PREVIEW_MAX_EDGE } from './limits';
import { currentOwner, expiryFor } from './session';
import { renderer } from './render';
import { layerKey, listMockups, previewKey, saveMockup } from './store';
import { RECORD_SCHEMA, type IngestProgress, type MockupRecord } from './types';

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** Throws a user-readable error if the file can't be accepted right now. */
export async function precheck(file: File): Promise<void> {
  const lower = file.name.toLowerCase();
  if (!ACCEPTED_EXT.some((e) => lower.endsWith(e))) throw new Error('Only .psd and .psb files are supported.');
  if (file.size > MAX_RAW_BYTES) {
    throw new Error(
      `${fmtBytes(file.size)} is over the ${fmtBytes(MAX_RAW_BYTES)} the browser can open. Save a smaller copy and try again.`,
    );
  }
  const existing = await listMockups();
  if (existing.length >= MAX_FILES) throw new Error(`Library is full (${MAX_FILES} files). Remove one first.`);
  const used = existing.reduce((s, m) => s + m.storedBytes, 0);
  if (used >= MAX_STORED_BYTES) throw new Error('Storage budget is full. Remove a file first.');
}

export async function ingestFile(file: File, onProgress: (p: IngestProgress) => void): Promise<MockupRecord> {
  await precheck(file);

  const worker = new IngestWorker();
  try {
    const result = await new Promise<IngestResult>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<IngestMessage>) => {
        if (e.data.type === 'progress') onProgress(e.data.progress);
        else if (e.data.type === 'done') resolve(e.data.result);
        else reject(new Error(e.data.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'The file was too large to open (out of memory).'));
      worker.postMessage({ file });
    });

    onProgress({ stage: 'saving', fraction: 0 });
    const id = crypto.randomUUID();
    const blobs = new Map<string, Blob>([[previewKey(id), result.preview]]);
    result.layerBlobs.forEach((b, i) => blobs.set(layerKey(id, i), b));
    const storedBytes = [...blobs.values()].reduce((s, b) => s + b.size, 0);

    const used = (await listMockups()).reduce((s, m) => s + m.storedBytes, 0);
    if (used + storedBytes > MAX_STORED_BYTES) {
      throw new Error(
        `Needs ${fmtBytes(storedBytes)} but only ${fmtBytes(MAX_STORED_BYTES - used)} of the ${fmtBytes(MAX_STORED_BYTES)} budget is free.`,
      );
    }

    const now = Date.now();
    const record: MockupRecord = {
      id,
      schema: RECORD_SCHEMA,
      designTargetId: result.designTargetId,
      warnings: result.warnings,
      name: file.name,
      rawBytes: file.size,
      storedBytes,
      width: result.width,
      height: result.height,
      layerCount: result.layerCount,
      smartObjectCount: result.smartObjectCount,
      layers: result.layers,
      createdAt: now,
      expiresAt: expiryFor(now),
      owner: currentOwner(),
    };
    await saveMockup(record, blobs);

    // The PSD's embedded flattened image is unreliable (16-bit files decode wrongly), so the stored preview is
    // rendered from the layers instead. If WebGL isn't available we keep the embedded one.
    try {
      const preview = await renderer().render(record, { maxEdge: PREVIEW_MAX_EDGE });
      record.storedBytes += preview.size - result.preview.size;
      await saveMockup(record, new Map([[previewKey(id), preview]]));
    } catch (e) {
      console.warn('Preview render failed, keeping the embedded preview.', e);
    }
    onProgress({ stage: 'saving', fraction: 1 });
    return record;
  } finally {
    worker.terminate(); // hands the (large) parse memory back to the browser immediately
  }
}
