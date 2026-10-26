import { describe, expect, it } from 'vitest';
import { buildPrompt, extractResult } from './ai';

const b64 = (s: string) => btoa(s);

describe('extractResult', () => {
  it('reads a generateContent response (camelCase)', () => {
    const { images, text } = extractResult({
      candidates: [{ content: { parts: [{ text: 'Done.' }, { inlineData: { mimeType: 'image/png', data: b64('PNGDATA') } }] } }],
    });
    expect(images).toHaveLength(1);
    expect(images[0].type).toBe('image/png');
    expect(images[0].size).toBe(7);
    expect(text).toBe('Done.');
  });

  it('reads snake_case inline_data too', () => {
    const { images } = extractResult({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/jpeg', data: b64('JPG') } }] } }] });
    expect(images[0].type).toBe('image/jpeg');
  });

  it('reads an interactions response with image and text blocks', () => {
    const { images, text } = extractResult({
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Edited.' }, { type: 'image', mime_type: 'image/webp', data: b64('WEBP') }] }],
    });
    expect(images[0].type).toBe('image/webp');
    expect(text).toBe('Edited.');
  });

  it('returns text only when the model sent no image', () => {
    const r = extractResult({ candidates: [{ content: { parts: [{ text: 'Which collar do you mean?' }] } }] });
    expect(r.images).toEqual([]);
    expect(r.text).toBe('Which collar do you mean?');
  });

  it('collects several images in order', () => {
    const { images } = extractResult({ parts: [{ inlineData: { data: b64('A') } }, { inlineData: { data: b64('BB') } }] });
    expect(images.map((i) => i.size)).toEqual([1, 2]);
  });

  it('copes with empty and odd input', () => {
    expect(extractResult(null)).toEqual({ images: [], text: '' });
    expect(extractResult({})).toEqual({ images: [], text: '' });
    expect(extractResult('nope')).toEqual({ images: [], text: '' });
  });
});

describe('buildPrompt', () => {
  it('keeps the change narrow and includes the request verbatim', () => {
    const p = buildPrompt('  make the collar ribbed ');
    expect(p).toContain('make the collar ribbed');
    expect(p).toMatch(/keep everything else/i);
    expect(p).toMatch(/design/i);
  });
});
