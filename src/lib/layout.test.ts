import { describe, expect, it } from 'vitest';
import { BENTO, effectiveSlots, gridAreas, slotOptions } from './layout';

describe('window layouts', () => {
  it('has a bento arrangement that places every window exactly once', () => {
    for (let n = 1; n <= 10; n++) {
      const names = new Set(BENTO[n].flatMap((r) => r.split(' ')));
      expect([...names].sort().join('')).toBe('abcdefghij'.slice(0, n));
      const widths = new Set(BENTO[n].map((r) => r.split(' ').length));
      expect(widths.size).toBe(1);
    }
  });

  it('greys out counts above the number of mockups, and nothing else', () => {
    const o = slotOptions(6);
    expect(o.map((x) => x.n)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(o.filter((x) => x.disabled).map((x) => x.n)).toEqual([7, 8, 9, 10]);
    expect(slotOptions(0).every((x) => x.disabled)).toBe(true);
    expect(slotOptions(10).some((x) => x.disabled)).toBe(false);
  });

  it('keeps 4 windows by default and falls back when mockups are removed', () => {
    expect(effectiveSlots(4, 0)).toBe(4);
    expect(effectiveSlots(8, 10)).toBe(8);
    expect(effectiveSlots(8, 6)).toBe(6);
    expect(effectiveSlots(8, 2)).toBe(4);
  });

  it('builds quoted grid-template-areas', () => {
    expect(gridAreas(2)).toBe('"ma mb"');
  });
});
