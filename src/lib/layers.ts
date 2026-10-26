import type { LayerMeta, MockupRecord } from './types';

export type DesignBlend = 'auto' | 'psd' | 'normal' | 'multiply';

/** Per-mockup changes made in the editor. Keys are layer paths, see flattenLayers. */
export interface Edits {
  colors: Record<string, string>;
  visible: Record<string, boolean>;
  opacity: Record<string, number>;
  /** How the design sits on the product. Absent = 'auto'. */
  designBlend?: DesignBlend;
}

export const emptyEdits = (): Edits => ({ colors: {}, visible: {}, opacity: {} });

export const isEdited = (e: Edits | undefined) =>
  !!e && ((e.designBlend ?? 'auto') !== 'auto' || Object.keys(e.colors).length > 0 || Object.keys(e.visible).length > 0 || Object.keys(e.opacity).length > 0);

export interface FlatLayer {
  /** Index path through the layer tree, e.g. "2.0". Stable for a given stored record. */
  path: string;
  depth: number;
  layer: LayerMeta;
}

export function flattenLayers(layers: LayerMeta[], depth = 0, prefix = ''): FlatLayer[] {
  const out: FlatLayer[] = [];
  layers.forEach((layer, i) => {
    const path = prefix ? `${prefix}.${i}` : String(i);
    out.push({ path, depth, layer });
    if (layer.children) out.push(...flattenLayers(layer.children, depth + 1, path));
  });
  return out;
}

/** Solid-color fill layers, which is how mockup makers expose "change the product color". */
export function colorLayers(rec: MockupRecord): FlatLayer[] {
  return flattenLayers(rec.layers).filter((f) => f.layer.kind === 'fill' && f.layer.fillColor);
}

const PRODUCT = /(shirt|tee|garment|product|fabric|cloth|hoodie|cap|mug|bag|object|base)/i;
const BACKGROUND = /(bg|back\s?ground)/i;

/** The fill layer most likely to be the product color: product-ish name first, then anything that isn't the background. */
export function primaryColorLayer(rec: MockupRecord): FlatLayer | undefined {
  const fills = colorLayers(rec);
  return (
    fills.find((f) => PRODUCT.test(f.layer.name) && /colou?r/i.test(f.layer.name)) ??
    fills.find((f) => PRODUCT.test(f.layer.name)) ??
    fills.find((f) => /colou?r/i.test(f.layer.name) && !BACKGROUND.test(f.layer.name)) ??
    undefined
  );
}

const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

/**
 * Mockup makers usually burn the design into a white product (Linear Burn / Multiply), which turns dark once the
 * product is recolored. 'auto' keeps the PSD's blend while the product is white and prints normally otherwise.
 * Returns the blend mode name to force, or undefined to keep the PSD's own.
 */
export function resolveDesignBlend(edits: Edits | undefined): string | undefined {
  const mode = edits?.designBlend ?? 'auto';
  if (mode === 'normal' || mode === 'multiply') return mode;
  if (mode === 'psd' || !edits) return undefined;
  const recolored = Object.entries(edits.colors).some(([path, hex]) => edits.visible[path] !== false && luminance(hex) < 0.93);
  return recolored ? 'normal' : undefined;
}

/** Accepts "#abc", "abc", "#aabbcc", "aabbcc" and returns "#rrggbb", or null. */
export function normalizeHex(input: string): string | null {
  const m = input.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(m)) return '#' + m.split('').map((c) => c + c).join('').toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(m)) return '#' + m.toLowerCase();
  return null;
}

/** Splits free text into unique valid colors (as #rrggbb) and the tokens that weren't colors. */
export function parseHexList(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
    const hex = normalizeHex(token);
    if (!hex) invalid.push(token);
    else if (!valid.includes(hex)) valid.push(hex);
  }
  return { valid, invalid };
}

export const SWATCHES = ['#ffffff', '#111111', '#6b7280', '#d62828', '#f77f00', '#fcbf49', '#2a9d8f', '#1d4ed8', '#1e3a5f', '#7b2cbf', '#ff6fb5', '#8b5e3c'];
