import { describe, expect, it } from 'vitest';
import { emptyEdits, flattenLayers, isEdited, normalizeHex, parseHexList, primaryColorLayer, resolveDesignBlend } from './layers';
import type { LayerMeta, MockupRecord } from './types';

const layer = (name: string, extra: Partial<LayerMeta> = {}): LayerMeta => ({
  name,
  kind: 'pixel',
  visible: true,
  opacity: 1,
  fillOpacity: 1,
  blendMode: 'normal',
  left: 0,
  top: 0,
  width: 10,
  height: 10,
  ...extra,
});

const fill = (name: string, color = '#ffffff', visible = true) => layer(name, { kind: 'fill', fillColor: color, visible });

/** The same shape as the real folded T-shirt mockup: product color hidden inside a group, background color elsewhere. */
function tee(): MockupRecord {
  return {
    id: 'm1',
    schema: 2,
    name: 'tee.psd',
    rawBytes: 1,
    storedBytes: 1,
    width: 100,
    height: 100,
    layerCount: 7,
    smartObjectCount: 1,
    createdAt: 0,
    expiresAt: null,
    owner: null,
    warnings: [],
    designTargetId: 'so1',
    layers: [
      layer('Mockup', { kind: 'group', children: [layer('Mockup', { kind: 'smartObject', placedId: 'so1' })] }),
      layer('T-Shirt', { kind: 'group', children: [fill('Color Fill 2'), fill('T-Shirt Color', '#59a3ff', false)] }),
      layer('Background', { kind: 'group', children: [fill('BG Color', '#eeeeee'), layer('Base')] }),
    ],
  };
}

describe('normalizeHex', () => {
  it('accepts 3 and 6 digit codes with or without #, any case', () => {
    expect(normalizeHex('#1D4ED8')).toBe('#1d4ed8');
    expect(normalizeHex('1d4ed8')).toBe('#1d4ed8');
    expect(normalizeHex('#abc')).toBe('#aabbcc');
    expect(normalizeHex('  FFF ')).toBe('#ffffff');
  });
  it('rejects anything else', () => {
    for (const bad of ['', '#12', '12345', '#1234567', 'ggg', 'notacolor', '#12 34 56']) expect(normalizeHex(bad)).toBeNull();
  });
});

describe('parseHexList', () => {
  it('splits on commas, spaces, semicolons and new lines', () => {
    expect(parseHexList('#111, #222\n333;444 555').valid).toEqual(['#111111', '#222222', '#333333', '#444444', '#555555']);
  });
  it('removes duplicates regardless of spelling', () => {
    expect(parseHexList('#abc, ABC, #aabbcc, #AABBCC').valid).toEqual(['#aabbcc']);
  });
  it('reports tokens that are not colors', () => {
    const r = parseHexList('#1d4ed8, red, #zzz');
    expect(r.valid).toEqual(['#1d4ed8']);
    expect(r.invalid).toEqual(['red', '#zzz']);
  });
  it('handles empty input', () => {
    expect(parseHexList('  \n ')).toEqual({ valid: [], invalid: [] });
  });
});

describe('flattenLayers', () => {
  it('assigns stable index paths that match the tree', () => {
    const flat = flattenLayers(tee().layers);
    expect(flat.map((f) => f.path)).toEqual(['0', '0.0', '1', '1.0', '1.1', '2', '2.0', '2.1']);
    expect(flat.find((f) => f.path === '1.1')?.layer.name).toBe('T-Shirt Color');
    expect(flat.find((f) => f.path === '1.1')?.depth).toBe(1);
  });
});

describe('primaryColorLayer', () => {
  it('picks the product color, not the background fill', () => {
    expect(primaryColorLayer(tee())?.path).toBe('1.1');
  });
  it('returns undefined when there is nothing recolorable', () => {
    const rec = { ...tee(), layers: [layer('Base')] };
    expect(primaryColorLayer(rec)).toBeUndefined();
  });
  it('never treats a background fill as the product', () => {
    const rec = { ...tee(), layers: [layer('G', { kind: 'group', children: [fill('BG Color')] })] };
    expect(primaryColorLayer(rec)).toBeUndefined();
  });
});

describe('resolveDesignBlend', () => {
  it('keeps the PSD blend while nothing is recolored', () => {
    expect(resolveDesignBlend(undefined)).toBeUndefined();
    expect(resolveDesignBlend(emptyEdits())).toBeUndefined();
  });
  it('prints normally once the product is a real color', () => {
    expect(resolveDesignBlend({ ...emptyEdits(), colors: { '1.1': '#1d4ed8' } })).toBe('normal');
  });
  it('keeps the PSD blend for white or near-white products', () => {
    expect(resolveDesignBlend({ ...emptyEdits(), colors: { '1.1': '#ffffff' } })).toBeUndefined();
    expect(resolveDesignBlend({ ...emptyEdits(), colors: { '1.1': '#f5f5f5' } })).toBeUndefined();
  });
  it('ignores color layers the user switched off', () => {
    expect(resolveDesignBlend({ ...emptyEdits(), colors: { '1.1': '#1d4ed8' }, visible: { '1.1': false } })).toBeUndefined();
  });
  it('honors an explicit choice over auto', () => {
    expect(resolveDesignBlend({ ...emptyEdits(), designBlend: 'multiply' })).toBe('multiply');
    expect(resolveDesignBlend({ ...emptyEdits(), designBlend: 'psd', colors: { '1.1': '#000000' } })).toBeUndefined();
  });
});

describe('isEdited', () => {
  it('is false for no edits and for the default blend', () => {
    expect(isEdited(undefined)).toBe(false);
    expect(isEdited(emptyEdits())).toBe(false);
    expect(isEdited({ ...emptyEdits(), designBlend: 'auto' })).toBe(false);
  });
  it('is true for any change', () => {
    expect(isEdited({ ...emptyEdits(), colors: { '1': '#000000' } })).toBe(true);
    expect(isEdited({ ...emptyEdits(), visible: { '1': false } })).toBe(true);
    expect(isEdited({ ...emptyEdits(), opacity: { '1': 0.5 } })).toBe(true);
    expect(isEdited({ ...emptyEdits(), designBlend: 'normal' })).toBe(true);
  });
});
