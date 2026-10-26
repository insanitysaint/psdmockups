export const DEFAULT_SLOTS = 4;
export const MAX_SLOTS = 10;

/** Grid-template-areas for each window count; every count has its own bento arrangement. */
export const BENTO: Record<number, string[]> = {
  1: ['a'],
  2: ['a b'],
  3: ['a b', 'a c'],
  4: ['a a b', 'c d b'],
  5: ['a a b', 'c d b', 'c e e'],
  6: ['a b c', 'd e f'],
  7: ['a a b c', 'd e f g'],
  8: ['a b c d', 'e f g h'],
  9: ['a b c', 'd e f', 'g h i'],
  10: ['a b c d e', 'f g h i j'],
};

/** The window count in effect: never below the default, and never more than the mockups available once above it. */
export function effectiveSlots(chosen: number, mockupCount: number): number {
  const wanted = Math.min(Math.max(chosen, DEFAULT_SLOTS), MAX_SLOTS);
  return wanted === DEFAULT_SLOTS ? DEFAULT_SLOTS : Math.max(DEFAULT_SLOTS, Math.min(wanted, mockupCount));
}

/** The 5..10 choices for the dropdown; counts beyond the number of mockups are disabled. */
export function slotOptions(mockupCount: number): { n: number; disabled: boolean }[] {
  return Array.from({ length: MAX_SLOTS - DEFAULT_SLOTS }, (_, i) => {
    const n = DEFAULT_SLOTS + 1 + i;
    return { n, disabled: n > mockupCount };
  });
}

export const gridAreas = (n: number): string =>
  BENTO[n].map((row) => `"${row.split(' ').map((c) => 'm' + c).join(' ')}"`).join(' ');
