import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ getToken: async () => 'test-token' }));

import { ResumableUpload, resetDriveFolder, uploadBlob } from './drive';

const MIB = 1024 * 1024;

interface Mock {
  stored: Uint8Array;
  puts: { range: string; len: number }[];
  init?: { name: string; parents: string[]; mimeType: string };
  folderQueries: number;
  folderCreates: number;
}

/** Implements the parts of Drive's resumable upload protocol the client relies on. */
function installDrive(opts: { hideRange?: boolean; failPut?: number; existingFolder?: boolean } = {}): Mock {
  const m: Mock = { stored: new Uint8Array(0), puts: [], folderQueries: 0, folderCreates: 0 };
  let failed = false;
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes('uploadType=resumable')) {
      m.init = JSON.parse(String(init.body));
      return new Response(null, { status: 200, headers: { Location: 'https://upload.test/session' } });
    }
    if (url.includes('/drive/v3/files?q=')) {
      m.folderQueries++;
      return new Response(JSON.stringify({ files: opts.existingFolder ? [{ id: 'existing' }] : [] }));
    }
    if (url.includes('/drive/v3/files?fields=id')) {
      m.folderCreates++;
      return new Response(JSON.stringify({ id: 'created' }));
    }
    if (url === 'https://upload.test/session') {
      const headers = init.headers as Record<string, string>;
      const cr = headers['Content-Range'];
      const body = init.body ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()) : new Uint8Array(0);
      const range = (n: number): Record<string, string> => (opts.hideRange ? {} : { Range: `bytes=0-${n - 1}` });
      if (cr === 'bytes */*') return new Response(null, { status: 308, headers: m.stored.length ? range(m.stored.length) : {} });
      m.puts.push({ range: cr, len: body.length });
      if (opts.failPut === m.puts.length && !failed) {
        failed = true;
        return new Response('busy', { status: 503 });
      }
      const match = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(cr)!;
      if (Number(match[1]) !== m.stored.length) return new Response('bad offset', { status: 400 });
      const next = new Uint8Array(m.stored.length + body.length);
      next.set(m.stored);
      next.set(body, m.stored.length);
      m.stored = next;
      if (match[3] !== '*' && m.stored.length === Number(match[3])) return new Response(JSON.stringify({ id: 'file1', name: m.init?.name }));
      return new Response(null, { status: 308, headers: range(m.stored.length) });
    }
    throw new Error('unexpected request ' + url);
  });
  return m;
}

/** Byte comparison without Vitest's deep diff, which runs out of memory on multi-megabyte arrays. */
function same(a: Uint8Array, b: Uint8Array) {
  expect(a.length).toBe(b.length);
  let firstDiff = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      firstDiff = i;
      break;
    }
  }
  expect(firstDiff).toBe(-1);
}

function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + (i >> 8)) & 255;
  return out;
}

async function upload(data: Uint8Array, pieces: number[]) {
  const up = new ResumableUpload('x.zip', 'application/zip');
  await up.start();
  let o = 0;
  for (let i = 0; o < data.length; i++) {
    const n = Math.min(pieces[i % pieces.length], data.length - o);
    await up.write(data.slice(o, o + n));
    o += n;
  }
  return up.finish();
}

beforeEach(() => resetDriveFolder());
afterEach(() => vi.unstubAllGlobals());

describe('ResumableUpload', () => {
  it('sends exact 8 MiB chunks and a final remainder, byte for byte', async () => {
    const m = installDrive();
    const data = bytes(20 * MIB + 12345);
    const file = await upload(data, [1000, 700_000, 3_000_000, 123]);
    expect(file.id).toBe('file1');
    same(m.stored, data);
    expect(m.puts.map((p) => p.len)).toEqual([8 * MIB, 8 * MIB, 4 * MIB + 12345]);
  });

  it('puts the file in a "Reskin Mockups" folder, creating it once', async () => {
    const m = installDrive();
    await upload(bytes(100), [100]);
    expect(m.init?.parents).toEqual(['created']);
    expect(m.folderCreates).toBe(1);
    const again = installDrive();
    await upload(bytes(100), [100]);
    expect(again.folderCreates + again.folderQueries).toBe(0); // the folder id is cached
  });

  it('reports a permanent error at once instead of retrying', async () => {
    installDrive();
    const up = new ResumableUpload('x.zip', 'application/zip');
    await up.start();
    // Drive answers with an error that retrying cannot fix.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'Bad offset' } }), { status: 400 }));
    const t = Date.now();
    await expect(up.write(bytes(9 * MIB))).rejects.toThrow(/Bad offset/);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('reuses an existing folder', async () => {
    const m = installDrive({ existingFolder: true });
    await upload(bytes(10), [10]);
    expect(m.init?.parents).toEqual(['existing']);
    expect(m.folderCreates).toBe(0);
  });

  it('still works when the browser cannot read the Range header', async () => {
    const m = installDrive({ hideRange: true });
    const data = bytes(9 * MIB);
    await upload(data, [2 * MIB]);
    same(m.stored, data);
  });

  it('recovers from a dropped request without duplicating or losing bytes', async () => {
    const m = installDrive({ failPut: 2 });
    const data = bytes(17 * MIB);
    await upload(data, [MIB]);
    same(m.stored, data);
  });

  it('handles a file smaller than one chunk', async () => {
    const m = installDrive();
    const data = bytes(5);
    await upload(data, [5]);
    same(m.stored, data);
    expect(m.puts).toHaveLength(1);
    expect(m.puts[0].range).toBe('bytes 0-4/5');
  });

  it('uploadBlob reports progress and returns the file', async () => {
    const m = installDrive();
    const data = bytes(10 * MIB);
    const seen: number[] = [];
    const file = await uploadBlob(new Blob([data as BlobPart], { type: 'image/png' }), 'a.png', (n) => seen.push(n));
    expect(file.id).toBe('file1');
    same(m.stored, data);
    expect(seen.at(-1)).toBe(10 * MIB);
  });
});
