import { describe, expect, it } from 'vitest';
import { emptyEdits } from './layers';
import { exportName, sizeChoices, slug } from './export';
import type { LayerMeta, MockupRecord } from './types';

const rec = (w = 4500, h = 3000): MockupRecord => ({
  id: 'm',
  schema: 2,
  name: '01 Free Folded T-Shirt Mockup.psd',
  rawBytes: 1,
  storedBytes: 1,
  width: w,
  height: h,
  layerCount: 1,
  smartObjectCount: 0,
  createdAt: 0,
  expiresAt: null,
  owner: null,
  warnings: [],
  layers: [
    {
      name: 'T-Shirt Color',
      kind: 'fill',
      fillColor: '#ffffff',
      visible: false,
      opacity: 1,
      fillOpacity: 1,
      blendMode: 'normal',
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    } as LayerMeta,
  ],
});

describe('slug', () => {
  it('lowercases, strips the extension and unsafe characters', () => {
    expect(slug('01 Free Folded T-Shirt Mockup.psd')).toBe('01-free-folded-t-shirt-mockup');
    expect(slug('My Design (final) v2!.png')).toBe('my-design-final-v2');
    expect(slug('weird/../name?.png')).toBe('weirdname');
  });
});

describe('exportName', () => {
  it('joins mockup, design and color', () => {
    const edits = { ...emptyEdits(), colors: { '0': '#1d4ed8' } };
    expect(exportName(rec(), 'Alpha Badge.png', edits, 'png')).toBe('01-free-folded-t-shirt-mockup_alpha-badge_1d4ed8.png');
  });
  it('leaves out what is not there', () => {
    expect(exportName(rec(), undefined, undefined, 'jpg')).toBe('01-free-folded-t-shirt-mockup.jpg');
  });
});

describe('sizeChoices', () => {
  it('offers original first, then smaller sizes that keep the aspect ratio', () => {
    const c = sizeChoices(rec());
    expect(c[0]).toEqual({ label: 'Original · 4500×3000' });
    expect(c.slice(1).map((x) => x.label)).toEqual(['3000×2000', '2000×1333', '1200×800']);
    expect(c.slice(1).map((x) => x.longEdge)).toEqual([3000, 2000, 1200]);
  });
  it('never offers an upscale', () => {
    expect(sizeChoices(rec(1500, 1000)).map((x) => x.longEdge)).toEqual([undefined, 1200]);
  });
});
