export const DESIGN_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.svg'];
export const MAX_DESIGN_BYTES = 50 * 1024 * 1024;
const SVG_EDGE = 2400;

/** Decodes an artwork file into a bitmap. SVGs are rasterized at a fixed size since they have no pixels of their own. */
export async function decodeDesign(file: File): Promise<ImageBitmap> {
  const lower = file.name.toLowerCase();
  if (!DESIGN_EXT.some((e) => lower.endsWith(e))) throw new Error('Use a PNG, JPG, WebP or SVG file.');
  if (file.size > MAX_DESIGN_BYTES) throw new Error('Design files can be up to 50 MB.');

  if (lower.endsWith('.svg')) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const w = img.naturalWidth || 1024;
      const h = img.naturalHeight || 1024;
      const k = SVG_EDGE / Math.max(w, h);
      const c = new OffscreenCanvas(Math.round(w * k), Math.round(h * k));
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      return createImageBitmap(c);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  try {
    return await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    throw new Error("That image couldn't be read. Try exporting it as PNG.");
  }
}
