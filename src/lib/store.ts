import { RECORD_SCHEMA, type MockupRecord } from './types';

const DB_NAME = 'reskin-mockups';
const DB_VERSION = 2;
const FILES = 'files';
const BLOBS = 'blobs';
const DESIGNS = 'designs';
const STATE = 'state';

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(FILES)) d.createObjectStore(FILES, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(BLOBS)) d.createObjectStore(BLOBS);
      if (!d.objectStoreNames.contains(DESIGNS)) d.createObjectStore(DESIGNS, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(STATE)) d.createObjectStore(STATE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const asPromise = <T,>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export const previewKey = (id: string) => `${id}:preview`;
export const layerKey = (id: string, n: number) => `${id}:layer:${n}`;

// --- mockups ---------------------------------------------------------------------------------------------------

export async function saveMockup(record: MockupRecord, blobs: Map<string, Blob>): Promise<void> {
  const d = await db();
  const tx = d.transaction([FILES, BLOBS], 'readwrite');
  tx.objectStore(FILES).put(record);
  for (const [k, v] of blobs) tx.objectStore(BLOBS).put(v, k);
  await done(tx);
}

export async function putBlob(key: string, blob: Blob): Promise<void> {
  const d = await db();
  const tx = d.transaction(BLOBS, 'readwrite');
  tx.objectStore(BLOBS).put(blob, key);
  await done(tx);
}

export async function listMockups(): Promise<MockupRecord[]> {
  const d = await db();
  const all = await asPromise(d.transaction(FILES).objectStore(FILES).getAll() as IDBRequest<MockupRecord[]>);
  // Records from an older stored shape can't be rendered; drop them so users simply re-add the file.
  const stale = all.filter((m) => m.schema !== RECORD_SCHEMA);
  for (const m of stale) await deleteMockup(m.id);
  return all.filter((m) => m.schema === RECORD_SCHEMA).sort((a, b) => a.createdAt - b.createdAt);
}

export async function getBlob(key: string): Promise<Blob | undefined> {
  const d = await db();
  return asPromise(d.transaction(BLOBS).objectStore(BLOBS).get(key) as IDBRequest<Blob | undefined>);
}

export async function deleteMockup(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction([FILES, BLOBS], 'readwrite');
  tx.objectStore(FILES).delete(id);
  tx.objectStore(BLOBS).delete(IDBKeyRange.bound(`${id}:`, `${id}:￿`));
  await done(tx);
}

// --- designs ---------------------------------------------------------------------------------------------------

/** A design kept between visits. The artwork and its thumbnail are stored as blobs next to this record. */
export interface StoredDesign {
  id: number;
  name: string;
  type: string;
  size: number;
  width: number;
  height: number;
  createdAt: number;
  /** null = never expires (signed-in user). */
  expiresAt: number | null;
  owner: string | null;
}

const designKey = (id: number) => `design:${id}`;
const designThumbKey = (id: number) => `design-thumb:${id}`;

export async function saveDesign(meta: StoredDesign, file: Blob, thumb: Blob): Promise<void> {
  const d = await db();
  const tx = d.transaction([DESIGNS, BLOBS], 'readwrite');
  tx.objectStore(DESIGNS).put(meta);
  tx.objectStore(BLOBS).put(file, designKey(meta.id));
  tx.objectStore(BLOBS).put(thumb, designThumbKey(meta.id));
  await done(tx);
}

export async function listDesigns(): Promise<StoredDesign[]> {
  const d = await db();
  const all = await asPromise(d.transaction(DESIGNS).objectStore(DESIGNS).getAll() as IDBRequest<StoredDesign[]>);
  return all.sort((a, b) => a.id - b.id);
}

export async function loadDesignBlobs(id: number): Promise<{ file?: Blob; thumb?: Blob }> {
  const [file, thumb] = await Promise.all([getBlob(designKey(id)), getBlob(designThumbKey(id))]);
  return { file, thumb };
}

export async function deleteStoredDesign(id: number): Promise<void> {
  const d = await db();
  const tx = d.transaction([DESIGNS, BLOBS], 'readwrite');
  tx.objectStore(DESIGNS).delete(id);
  tx.objectStore(BLOBS).delete(designKey(id));
  tx.objectStore(BLOBS).delete(designThumbKey(id));
  await done(tx);
}

// --- small settings (edits, bulk options, design choice) ---------------------------------------------------------

export async function getState<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return asPromise(d.transaction(STATE).objectStore(STATE).get(key) as IDBRequest<T | undefined>);
}

export async function setState(key: string, value: unknown): Promise<void> {
  const d = await db();
  const tx = d.transaction(STATE, 'readwrite');
  tx.objectStore(STATE).put(value, key);
  await done(tx);
}

// --- lifecycle ---------------------------------------------------------------------------------------------------

/** Deletes expired guest files and designs, and returns the mockup ids that were removed. */
export async function sweepExpired(now = Date.now()): Promise<string[]> {
  const expired = (await listMockups()).filter((m) => m.expiresAt !== null && m.expiresAt <= now);
  for (const m of expired) await deleteMockup(m.id);
  for (const s of (await listDesigns()).filter((x) => x.expiresAt !== null && x.expiresAt <= now)) await deleteStoredDesign(s.id);
  return expired.map((m) => m.id);
}

/** On sign-in, files added as a guest become the account's and stop expiring. */
export async function adoptGuestFiles(owner: string): Promise<void> {
  const d = await db();
  for (const m of await listMockups()) {
    if (m.owner === null) await saveMockup({ ...m, owner, expiresAt: null }, new Map());
  }
  for (const s of await listDesigns()) {
    if (s.owner === null) {
      const tx = d.transaction(DESIGNS, 'readwrite');
      tx.objectStore(DESIGNS).put({ ...s, owner, expiresAt: null });
      await done(tx);
    }
  }
}

/** On sign-out (or when the app starts with nobody signed in), kept files go back on the guest timer. */
export async function releaseOwnedFiles(now: number, ttlMs: number): Promise<void> {
  const d = await db();
  for (const m of await listMockups()) {
    if (m.owner !== null) await saveMockup({ ...m, owner: null, expiresAt: now + ttlMs }, new Map());
  }
  for (const s of await listDesigns()) {
    if (s.owner !== null) {
      const tx = d.transaction(DESIGNS, 'readwrite');
      tx.objectStore(DESIGNS).put({ ...s, owner: null, expiresAt: now + ttlMs });
      await done(tx);
    }
  }
}
