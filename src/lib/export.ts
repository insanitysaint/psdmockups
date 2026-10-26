import type { Edits } from './layers';
import { primaryColorLayer } from './layers';
import { renderer, type Design } from './render';
import type { MockupRecord } from './types';

export type ExportFormat = 'png' | 'jpg' | 'webp';

export interface ExportOptions {
  format: ExportFormat;
  /** Longest edge in pixels; undefined = the mockup's original size. */
  longEdge?: number;
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' } as const;

export const slug = (s: string) =>
  s
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();

/** e.g. "01-free-folded-t-shirt-mockup_reskin-test-design_1d4ed8.png" */
export function exportName(rec: MockupRecord, designName: string | undefined, edits: Edits | undefined, format: ExportFormat): string {
  const parts = [slug(rec.name) || 'mockup'];
  if (designName) parts.push(slug(designName));
  const primary = primaryColorLayer(rec);
  const hex = primary && edits?.colors[primary.path];
  if (hex) parts.push(hex.slice(1));
  return `${parts.join('_')}.${format}`;
}

export function sizeChoices(rec: MockupRecord): { label: string; longEdge?: number }[] {
  const long = Math.max(rec.width, rec.height);
  const dims = (e: number) => {
    const k = e / long;
    return `${Math.round(rec.width * k)}×${Math.round(rec.height * k)}`;
  };
  const out: { label: string; longEdge?: number }[] = [{ label: `Original · ${rec.width}×${rec.height}` }];
  for (const e of [3000, 2000, 1200]) if (e < long) out.push({ label: `${dims(e)}`, longEdge: e });
  return out;
}

/** Renders at full quality without touching the preview texture cache. */
export function exportMockup(rec: MockupRecord, design: Design | null, edits: Edits | undefined, opts: ExportOptions): Promise<Blob> {
  return renderer().render(rec, {
    maxEdge: opts.longEdge ?? Math.max(rec.width, rec.height),
    design,
    edits,
    cache: false,
    format: MIME[opts.format],
  });
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
