import { getToken } from './auth';

const API = 'https://www.googleapis.com';
const FOLDER_NAME = 'Reskin Mockups';
/** Resumable chunks must be a multiple of 256 KiB; 8 MiB keeps memory flat for big zips. */
const CHUNK = 8 * 1024 * 1024;

/** A failure retrying can't fix (bad request, permissions, expired session): reported immediately. */
class UploadFailure extends Error {}

export interface DriveFile {
  id: string;
  name: string;
  webViewLink?: string;
}

async function authed(url: string, init: RequestInit = {}): Promise<Response> {
  const go = async () =>
    fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await getToken()}` } });
  return go();
}

async function jsonOrThrow<T>(res: Response, what: string): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let detail = '';
  try {
    detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? '';
  } catch {
    /* no body */
  }
  if (res.status === 401) throw new Error('Your Google session expired. Sign in again.');
  if (res.status === 403) throw new Error(`Google Drive refused ${what}${detail ? `: ${detail}` : '. Check that the Drive API is enabled for this app.'}`);
  throw new Error(`${what} failed (${res.status})${detail ? `: ${detail}` : ''}`);
}

let folderId: string | undefined;

/** Finds or creates the "Reskin Mockups" folder. With the drive.file scope we only ever see folders this app made. */
async function ensureFolder(): Promise<string> {
  if (folderId) return folderId;
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await jsonOrThrow<{ files: { id: string }[] }>(await authed(`${API}/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`), 'Looking for the Drive folder');
  if (found.files[0]) return (folderId = found.files[0].id);
  const made = await jsonOrThrow<{ id: string }>(
    await authed(`${API}/drive/v3/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    }),
    'Creating the Drive folder',
  );
  return (folderId = made.id);
}

/** Forget the cached folder (e.g. the user deleted it in Drive). */
export const resetDriveFolder = () => (folderId = undefined);

/**
 * Resumable upload: bytes are pushed in order and the session survives a dropped request, so a 500 MB zip
 * doesn't need to sit in memory or restart from zero.
 */
export class ResumableUpload {
  private session?: string;
  private sent = 0;
  private buffer: Uint8Array[] = [];
  private buffered = 0;

  constructor(
    private name: string,
    private mime: string,
    private onProgress?: (sent: number) => void,
  ) {}

  async start(): Promise<void> {
    const parents = [await ensureFolder()];
    const res = await authed(`${API}/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': this.mime },
      body: JSON.stringify({ name: this.name, mimeType: this.mime, parents }),
    });
    if (!res.ok) await jsonOrThrow(res, 'Starting the Drive upload');
    const session = res.headers.get('Location');
    if (!session) throw new Error('Google Drive did not return an upload session.');
    this.session = session;
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.buffer.push(chunk);
    this.buffered += chunk.length;
    while (this.buffered >= CHUNK) {
      const block = this.take(CHUNK);
      await this.put(block, false);
    }
  }

  async finish(): Promise<DriveFile> {
    const rest = this.take(this.buffered);
    const file = await this.put(rest, true);
    if (!file) throw new Error('Drive finished the upload without returning the file.');
    return file;
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const head = this.buffer[0];
      const need = n - o;
      if (head.length <= need) {
        out.set(head, o);
        o += head.length;
        this.buffer.shift();
      } else {
        out.set(head.subarray(0, need), o);
        this.buffer[0] = head.subarray(need);
        o += need;
      }
    }
    this.buffered -= n;
    return out;
  }

  private async put(block: Uint8Array, final: boolean): Promise<DriveFile | undefined> {
    const start = this.sent;
    const end = start + block.length;
    let offset = 0; // how much of `block` Drive has confirmed
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const part = block.subarray(offset);
        const from = start + offset;
        const range = part.length ? `bytes ${from}-${end - 1}/${final ? end : '*'}` : `bytes */${final ? end : '*'}`;
        const res = await fetch(this.session!, { method: 'PUT', headers: { 'Content-Range': range }, body: part as BodyInit });
        if (res.status === 308) {
          // 308 = "got it, send more". The Range header says how much Drive kept; if the browser can't read it
          // (CORS may hide it) we trust the 308 rather than risk resending bytes twice.
          const hdr = res.headers.get('Range');
          if (!hdr) break;
          const committed = /bytes=0-(\d+)/.exec(hdr);
          const have = committed ? Number(committed[1]) + 1 : 0;
          if (have >= end) break;
          offset = Math.max(0, have - start); // Drive kept less than we sent: resend the rest
          continue;
        }
        if (res.ok) {
          this.sent = end;
          this.onProgress?.(this.sent);
          return final ? ((await res.json()) as DriveFile) : undefined;
        }
        if (res.status >= 500 || res.status === 429) throw new Error(`Drive returned ${res.status}`);
        try {
          await jsonOrThrow(res, 'Uploading to Drive');
        } catch (e) {
          throw new UploadFailure(e instanceof Error ? e.message : String(e));
        }
      } catch (e) {
        if (e instanceof UploadFailure) throw e;
        if (attempt === 3) throw e instanceof Error ? e : new Error(String(e));
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        // Ask Drive where we really are before retrying. If it can't tell us, retrying blind could corrupt the file.
        const known = await this.committed(start);
        if (known === undefined) throw e instanceof Error ? e : new Error(String(e));
        offset = known;
      }
    }
    this.sent = end;
    this.onProgress?.(this.sent);
    return undefined;
  }

  private async committed(start: number): Promise<number | undefined> {
    try {
      const res = await fetch(this.session!, { method: 'PUT', headers: { 'Content-Range': 'bytes */*' } });
      if (res.status !== 308) return undefined;
      const hdr = res.headers.get('Range');
      if (!hdr) return 0; // a 308 with no Range means nothing has been stored yet
      const m = /bytes=0-(\d+)/.exec(hdr);
      return m ? Math.max(0, Number(m[1]) + 1 - start) : undefined;
    } catch {
      return undefined;
    }
  }
}

export async function uploadBlob(blob: Blob, name: string, onProgress?: (sent: number) => void): Promise<DriveFile> {
  const up = new ResumableUpload(name, blob.type || 'application/octet-stream', onProgress);
  await up.start();
  for (let o = 0; o < blob.size; o += CHUNK) await up.write(new Uint8Array(await blob.slice(o, o + CHUNK).arrayBuffer()));
  return up.finish();
}

export const driveLink = (f: DriveFile) => f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`;
