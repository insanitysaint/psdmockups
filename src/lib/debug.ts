import { renderer } from './render';
import { getBlob, listMockups, previewKey } from './store';

/**
 * Dev-only helpers exposed on window.__reskin for checking the renderer against the PSD's own flattened image.
 */
async function pixels(blob: Blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

export async function compareWithPreview(id?: string) {
  const rec = (await listMockups()).find((m) => !id || m.id === id);
  if (!rec) throw new Error('no mockup');
  const ref = await getBlob(previewKey(rec.id));
  if (!ref) throw new Error('no preview');
  const a = await pixels(ref);
  const t0 = performance.now();
  const mine = await renderer().render(rec, { maxEdge: Math.max(a.width, a.height), design: null, format: 'image/png' });
  const ms = performance.now() - t0;
  const b = await pixels(mine);
  if (a.width !== b.width || a.height !== b.height) return { error: `size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  let sum = 0, over8 = 0, over24 = 0, max = 0;
  const n = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
    sum += d;
    if (d > 8) over8++;
    if (d > 24) over24++;
    if (d > max) max = d;
  }
  return {
    size: `${a.width}x${a.height}`,
    renderMs: Math.round(ms),
    meanAbsDiff: +(sum / n).toFixed(2),
    pctOver8: +((over8 / n) * 100).toFixed(2),
    pctOver24: +((over24 / n) * 100).toFixed(2),
    maxDiff: Math.round(max),
    refUrl: URL.createObjectURL(ref),
    mineUrl: URL.createObjectURL(mine),
  };
}

(window as unknown as { __reskin: unknown }).__reskin = { compareWithPreview, renderer, listMockups };
