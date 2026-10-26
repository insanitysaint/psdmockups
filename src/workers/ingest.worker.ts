/// <reference lib="webworker" />
import { initializeCanvas, readPsd, type Layer } from 'ag-psd';
import { PREVIEW_MAX_EDGE } from '../lib/limits';
import type { CurvesMeta, IngestProgress, LayerMeta } from '../lib/types';

// ag-psd asks for a canvas factory even in raw-ImageData mode; workers only have OffscreenCanvas.
initializeCanvas((w, h) => new OffscreenCanvas(w, h) as unknown as HTMLCanvasElement);

export interface IngestRequest {
  file: File;
}

export interface IngestResult {
  width: number;
  height: number;
  layers: LayerMeta[];
  layerCount: number;
  smartObjectCount: number;
  preview: Blob;
  layerBlobs: Blob[];
  designTargetId?: string;
  warnings: string[];
}

export type IngestMessage =
  | { type: 'progress'; progress: IngestProgress }
  | { type: 'done'; result: IngestResult }
  | { type: 'error'; message: string };

const post = (m: IngestMessage) => (self as unknown as Worker).postMessage(m);
const progress = (stage: IngestProgress['stage'], fraction: number) =>
  post({ type: 'progress', progress: { stage, fraction } });

interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** 16-bit documents give us Uint16Array pixels; canvases and WebP want 8-bit. */
function to8(img: { data: ArrayLike<number>; width: number; height: number }): Pixels {
  if (img.data instanceof Uint8ClampedArray) return img as Pixels;
  const src = img.data;
  const out = new Uint8ClampedArray(src.length);
  const wide = src instanceof Uint16Array;
  for (let i = 0; i < src.length; i++) out[i] = wide ? (src[i] + 128) / 257 : src[i];
  return { data: out, width: img.width, height: img.height };
}

/** Area-average downscale so we never allocate a full-size canvas for the preview. */
function downscale(src: Pixels, maxEdge: number): Pixels {
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height));
  if (scale === 1) return src;
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const bx = src.width / w;
  const by = src.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * by);
    const y1 = Math.min(src.height, Math.max(y0 + 1, Math.floor((y + 1) * by)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * bx);
      const x1 = Math.min(src.width, Math.max(x0 + 1, Math.floor((x + 1) * bx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * src.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          const al = src.data[i + 3];
          r += src.data[i] * al;
          g += src.data[i + 1] * al;
          b += src.data[i + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
      }
      out[o + 3] = a / n;
    }
  }
  return { data: out, width: w, height: h };
}

async function encode(px: Pixels, quality: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(px.width, px.height);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(px.data), px.width, px.height), 0, 0);
  // WebP keeps alpha and is far smaller than PNG; browsers that can't encode it fall back to PNG.
  return canvas.convertToBlob({ type: 'image/webp', quality });
}

/** PSDs saved without "Maximize Compatibility" carry no flattened image; we detect that by sampling. */
function looksBlank(px: Pixels): boolean {
  const total = px.width * px.height;
  const step = Math.max(1, Math.floor(total / 2000));
  for (let p = 0; p < total; p += step) {
    const i = p * 4;
    if (px.data[i + 3] !== 0 && (px.data[i] | px.data[i + 1] | px.data[i + 2]) !== 0) return false;
  }
  return true;
}

const BLEND: Record<string, GlobalCompositeOperation> = {
  multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten',
  'color dodge': 'color-dodge', 'color burn': 'color-burn', 'hard light': 'hard-light',
  'soft light': 'soft-light', difference: 'difference', exclusion: 'exclusion', hue: 'hue',
  saturation: 'saturation', color: 'color', luminosity: 'luminosity', 'linear dodge': 'lighter',
};

/** Approximate preview built from the layer stack, for files that have no embedded composite. */
function composeFromLayers(psd: { width: number; height: number; children?: Layer[] }): Pixels {
  const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(psd.width, psd.height));
  const w = Math.max(1, Math.round(psd.width * scale));
  const h = Math.max(1, Math.round(psd.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  const draw = (ls: Layer[] | undefined) => {
    for (const l of ls ?? []) {
      if (l.hidden) continue;
      if (l.children) { draw(l.children); continue; }
      const raw = l.imageData as Pixels | undefined;
      if (!raw || raw.width === 0 || raw.height === 0) continue;
      const img = to8(raw);
      const tmp = new OffscreenCanvas(img.width, img.height);
      tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
      ctx.globalAlpha = l.opacity ?? 1;
      ctx.globalCompositeOperation = BLEND[l.blendMode ?? 'normal'] ?? 'source-over';
      ctx.drawImage(tmp, (l.left ?? 0) * scale, (l.top ?? 0) * scale, img.width * scale, img.height * scale);
    }
  };
  draw(psd.children);
  const out = ctx.getImageData(0, 0, w, h);
  return { data: out.data, width: w, height: h };
}

const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

function kindOf(l: Layer): LayerMeta['kind'] {
  if (l.children) return 'group';
  if (l.placedLayer) return 'smartObject';
  if (l.text) return 'text';
  if (l.vectorFill && l.vectorFill.type === 'color') return 'fill';
  if (l.adjustment) return 'adjustment';
  return 'pixel';
}

async function ingest(file: File): Promise<IngestResult> {
  progress('reading', 0);
  const buffer = await file.arrayBuffer();
  progress('reading', 1);

  progress('parsing', 0);
  const psd = readPsd(buffer, { useImageData: true, skipThumbnail: true });
  if (!psd.children?.length) {
    // ag-psd swallows layer-read errors and returns no layers; a mockup without layers is useless, so say so.
    throw new Error("Couldn't read any layers from this file. It may be flattened or use features we can't read yet.");
  }
  progress('parsing', 1);

  const layerBlobs: Blob[] = [];
  let layerCount = 0;
  let smartObjectCount = 0;
  let leafTotal = 0;
  const countLeaves = (ls: Layer[] | undefined) =>
    ls?.forEach((l) => (l.children ? countLeaves(l.children) : leafTotal++));
  countLeaves(psd.children);
  let done = 0;

  // Preview first, from the flattened composite, then free it.
  const rawComposite = psd.imageData as Pixels | undefined;
  const composite = rawComposite ? to8(rawComposite) : undefined;
  const flat = composite && !looksBlank(composite) ? downscale(composite, PREVIEW_MAX_EDGE) : composeFromLayers(psd);
  const preview = await encode(flat, 0.85);
  psd.imageData = undefined;

  const warnings: string[] = [];
  const maskCache = new Map<string, number>();
  const smartObjects: { id: string; name: string; area: number; visible: boolean }[] = [];

  /** Masks are stored as lossless grayscale PNGs; identical masks (common in mockups) are stored once. */
  const storeMask = async (img: Pixels): Promise<number> => {
    const px = to8(img);
    const rgba = new Uint8ClampedArray(px.data.length);
    let h = 2166136261;
    for (let i = 0; i < px.data.length; i += 4) {
      const g = px.data[i];
      rgba[i] = rgba[i + 1] = rgba[i + 2] = g;
      rgba[i + 3] = 255;
      h = Math.imul(h ^ g, 16777619);
    }
    const key = `${px.width}x${px.height}:${h >>> 0}`;
    const hit = maskCache.get(key);
    if (hit !== undefined) return hit;
    const canvas = new OffscreenCanvas(px.width, px.height);
    canvas.getContext('2d')!.putImageData(new ImageData(rgba, px.width, px.height), 0, 0);
    layerBlobs.push(await canvas.convertToBlob({ type: 'image/png' }));
    maskCache.set(key, layerBlobs.length - 1);
    return layerBlobs.length - 1;
  };

  const walk = async (ls: Layer[] | undefined): Promise<LayerMeta[]> => {
    const out: LayerMeta[] = [];
    // PSD stores layers bottom-to-top; the UI wants top-to-bottom.
    for (const l of [...(ls ?? [])].reverse()) {
      layerCount++;
      const kind = kindOf(l);
      if (kind === 'smartObject') smartObjectCount++;
      const left = l.left ?? 0;
      const top = l.top ?? 0;
      const fillOpacity = l.fillOpacity ?? 1;
      const opacity = l.opacity ?? 1;
      const meta: LayerMeta = {
        name: l.name ?? '',
        kind,
        visible: !l.hidden,
        opacity,
        fillOpacity,
        blendMode: l.blendMode ?? 'normal',
        left,
        top,
        width: (l.right ?? left) - left,
        height: (l.bottom ?? top) - top,
      };
      const note = (what: string) => meta.visible && warnings.push(`${meta.name}: ${what}`);
      if (l.placedLayer) {
        meta.placedQuad = [...l.placedLayer.transform];
        meta.placedId = l.placedLayer.id;
        meta.placedSize = [l.placedLayer.width ?? meta.width, l.placedLayer.height ?? meta.height];
        const style = l.placedLayer.warp?.style;
        if ((style && style !== 'none') || l.placedLayer.nonAffineTransform) note('warped smart object, placed as a flat quad');
        if (l.opacity !== 0 && fillOpacity !== 0) {
          smartObjects.push({ id: l.placedLayer.id, name: meta.name, area: meta.width * meta.height, visible: meta.visible });
        }
      }
      if (l.vectorFill && l.vectorFill.type === 'color') {
        const c = l.vectorFill.color as { r: number; g: number; b: number };
        meta.fillColor = `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
      }
      if (l.adjustment) {
        if (l.adjustment.type === 'curves') {
          const a = l.adjustment as { rgb?: CurvesMeta['rgb']; red?: CurvesMeta['rgb']; green?: CurvesMeta['rgb']; blue?: CurvesMeta['rgb'] };
          meta.curves = { rgb: a.rgb, red: a.red, green: a.green, blue: a.blue };
        } else {
          note(`${l.adjustment.type} adjustment not supported yet`);
        }
      }
      if (l.vectorMask) note('vector mask ignored');
      if (l.clipping) note('clipping mask not supported yet');
      if (l.effects) note('layer styles not rendered');
      if (l.children && meta.visible && l.blendMode && l.blendMode !== 'pass through' && l.blendMode !== 'normal') {
        note(`group blend mode "${l.blendMode}" treated as pass-through`);
      }

      const m = l.mask;
      if (m && !m.disabled) {
        const mi = m.imageData as Pixels | undefined;
        meta.mask = {
          left: m.left ?? 0,
          top: m.top ?? 0,
          right: m.right ?? 0,
          bottom: m.bottom ?? 0,
          defaultColor: m.defaultColor ?? 0,
        };
        if (m.positionRelativeToLayer) note('mask positioned relative to layer not supported yet');
        if (mi && mi.width > 0 && mi.height > 0) meta.mask.blob = await storeMask(mi);
      }
      if (m) m.imageData = undefined;

      if (l.children) {
        meta.children = await walk(l.children);
      } else {
        const raw = l.imageData as Pixels | undefined;
        // Layers that contribute nothing (e.g. the invisible "Place your design" placeholder) need no pixels.
        if (raw && raw.width > 0 && raw.height > 0 && opacity * fillOpacity > 0) {
          meta.blob = layerBlobs.length;
          layerBlobs.push(await encode(to8(raw), 0.92));
        }
        l.imageData = undefined; // release decoded pixels as we go
        progress('compressing', ++done / Math.max(1, leafTotal));
      }
      out.push(meta);
    }
    return out;
  };

  progress('compressing', 0);
  const layers = await walk(psd.children);

  // The design target is the smart object whose name suggests "put your artwork here", else the biggest one.
  const named = smartObjects.find((s) => /design|artwork|your|place|print|logo/i.test(s.name));
  const designTargetId = (named ?? [...smartObjects].sort((a, b) => b.area - a.area)[0])?.id;
  return {
    width: psd.width,
    height: psd.height,
    layers,
    layerCount,
    smartObjectCount,
    preview,
    layerBlobs,
    designTargetId,
    warnings: [...new Set(warnings)],
  };
}

self.onmessage = async (e: MessageEvent<IngestRequest>) => {
  try {
    post({ type: 'done', result: await ingest(e.data.file) });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
