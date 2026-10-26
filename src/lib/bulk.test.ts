import { describe, expect, it } from 'vitest';
import { planJobs } from './bulk';
import type { LayerMeta, MockupRecord } from './types';
import type { DesignItem } from './useDesigns';

const fillLayer = (name: string): LayerMeta => ({
  name,
  kind: 'fill',
  fillColor: '#ffffff',
  visible: true,
  opacity: 1,
  fillOpacity: 1,
  blendMode: 'normal',
  left: 0,
  top: 0,
  width: 0,
  height: 0,
});

const mockup = (id: string, name: string, opts: { target?: boolean; color?: boolean } = {}): MockupRecord => ({
  id,
  schema: 2,
  name,
  rawBytes: 1,
  storedBytes: 1,
  width: 100,
  height: 100,
  layerCount: 1,
  smartObjectCount: 1,
  createdAt: 0,
  expiresAt: null,
  owner: null,
  warnings: [],
  designTargetId: opts.target === false ? undefined : 'so',
  layers: opts.color === false ? [] : [fillLayer('T-Shirt Color')],
});

const design = (id: number, name: string): DesignItem => ({ id, name, file: new File([], name), thumb: '', width: 1, height: 1 });

describe('planJobs', () => {
  const m = mockup('m1', 'Tee Front.psd');
  const ds = [design(1, 'Alpha.png'), design(2, 'Beta.png')];

  it('makes one image per design and color', () => {
    const { jobs, notes } = planJobs([m], ds, ['#111111', '#d62828', '#1d4ed8'], false, 'png', true);
    expect(jobs).toHaveLength(6);
    expect(notes).toEqual([]);
  });

  it('adds the mockup\'s own color only when asked, or when there are no colors', () => {
    expect(planJobs([m], ds, ['#111111'], true, 'png', true).jobs).toHaveLength(4);
    const none = planJobs([m], ds, [], false, 'png', true).jobs;
    expect(none).toHaveLength(2);
    expect(none.every((j) => j.color === null)).toBe(true);
  });

  it('orders mockup, then design, then color so textures stay hot', () => {
    const m2 = mockup('m2', 'Hoodie.psd');
    const { jobs } = planJobs([m, m2], ds, ['#111111', '#222222'], false, 'png', true);
    expect(jobs.map((j) => `${j.mockup.id}/${j.design.id}/${j.color}`)).toEqual([
      'm1/1/#111111', 'm1/1/#222222', 'm1/2/#111111', 'm1/2/#222222',
      'm2/1/#111111', 'm2/1/#222222', 'm2/2/#111111', 'm2/2/#222222',
    ]);
  });

  it('names files and groups them by design', () => {
    const { jobs } = planJobs([m], [ds[0]], ['#1D4ED8'], true, 'jpg', true);
    expect(jobs.map((j) => j.path)).toEqual(['alpha/tee-front_alpha_original.jpg', 'alpha/tee-front_alpha_1d4ed8.jpg']);
  });

  it('can put everything in one flat folder', () => {
    const { jobs } = planJobs([m], ds, ['#111111'], false, 'webp', false);
    expect(jobs.map((j) => j.path)).toEqual(['tee-front_alpha_111111.webp', 'tee-front_beta_111111.webp']);
  });

  it('never produces two files with the same path', () => {
    const twins = [design(1, 'logo.png'), design(2, 'logo.jpg')];
    const { jobs } = planJobs([m], twins, ['#111111'], false, 'png', true);
    expect(new Set(jobs.map((j) => j.path)).size).toBe(2);
    expect(jobs[1].path).toBe('logo/tee-front_logo_111111-2.png');
  });

  it('skips mockups with no design area and says so', () => {
    const { jobs, notes } = planJobs([mockup('x', 'Flat.psd', { target: false }), m], ds, ['#111111'], false, 'png', true);
    expect(jobs.every((j) => j.mockup.id === 'm1')).toBe(true);
    expect(notes[0]).toMatch(/Flat\.psd.*no design area/);
  });

  it('exports once per design when a mockup has no color layer', () => {
    const { jobs, notes } = planJobs([mockup('p', 'Poster.psd', { color: false })], ds, ['#111111', '#222222'], false, 'png', true);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.color === null)).toBe(true);
    expect(notes[0]).toMatch(/no color layer/);
  });

  it('returns nothing when there are no designs', () => {
    expect(planJobs([m], [], ['#111111'], false, 'png', true).jobs).toEqual([]);
  });
});
