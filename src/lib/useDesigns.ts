import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeDesign } from './design';
import { fmtBytes } from './ingest';
import type { Design, FitMode } from './render';
import { currentOwner, expiryFor } from './session';
import { deleteStoredDesign, getState, listDesigns, loadDesignBlobs, saveDesign, setState } from './store';

export const MAX_DESIGNS = 40;
/** Designs are kept between visits, so their total size is capped separately from the mockup budget. */
export const MAX_DESIGN_STORE_BYTES = 400 * 1024 * 1024;
const PREFS_KEY = 'designPrefs';

/** A design in the library. Only the active one keeps a decoded bitmap, so 40 large files don't fill memory. */
export interface DesignItem {
  id: number;
  name: string;
  file: File;
  thumb: string;
  width: number;
  height: number;
}

export type ActiveDesign = Design & { id: number; name: string };

async function thumbnail(bitmap: ImageBitmap): Promise<Blob> {
  const c = new OffscreenCanvas(96, 96);
  const ctx = c.getContext('2d')!;
  const k = Math.min(96 / bitmap.width, 96 / bitmap.height);
  ctx.drawImage(bitmap, (96 - bitmap.width * k) / 2, (96 - bitmap.height * k) / 2, bitmap.width * k, bitmap.height * k);
  return c.convertToBlob({ type: 'image/png' });
}

export function useDesigns() {
  const [items, setItems] = useState<DesignItem[]>([]);
  const [active, setActive] = useState<{ id: number; bitmap: ImageBitmap } | null>(null);
  const [fit, setFit] = useState<FitMode>('contain');
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const counter = useRef(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeRef = useRef(active);
  activeRef.current = active;
  const loading = useRef(false);

  const activate = useCallback(async (id: number) => {
    const item = itemsRef.current.find((d) => d.id === id);
    if (!item) return;
    try {
      const bitmap = await decodeDesign(item.file);
      setActive((prev) => {
        prev?.bitmap.close();
        return { id, bitmap };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Restore the library from the last visit (guest designs older than 24h were already swept by the app).
  useEffect(() => {
    if (loading.current) return;
    loading.current = true;
    (async () => {
      try {
        const restored: DesignItem[] = [];
        for (const meta of await listDesigns()) {
          if (meta.expiresAt !== null && meta.expiresAt <= Date.now()) {
            await deleteStoredDesign(meta.id); // a guest design past its 24 hours
            continue;
          }
          const { file, thumb } = await loadDesignBlobs(meta.id);
          if (!file || !thumb) {
            await deleteStoredDesign(meta.id);
            continue;
          }
          restored.push({
            id: meta.id,
            name: meta.name,
            file: new File([file], meta.name, { type: meta.type }),
            thumb: URL.createObjectURL(thumb),
            width: meta.width,
            height: meta.height,
          });
          counter.current = Math.max(counter.current, meta.id);
        }
        itemsRef.current = restored;
        setItems(restored);
        const prefs = await getState<{ activeId: number | null; fit: FitMode }>(PREFS_KEY);
        if (prefs?.fit) setFit(prefs.fit);
        const first = restored.find((d) => d.id === prefs?.activeId) ?? restored[0];
        if (first) await activate(first.id);
      } catch (e) {
        console.warn('Could not restore saved designs', e);
      } finally {
        setReady(true);
      }
    })();
  }, [activate]);

  // Remember which design is active and how it is fitted.
  useEffect(() => {
    if (ready) void setState(PREFS_KEY, { activeId: active?.id ?? null, fit }).catch(() => undefined);
  }, [ready, active?.id, fit]);

  const add = useCallback(async (files: FileList | File[]) => {
    setError(undefined);
    const errors: string[] = [];
    for (const file of [...files]) {
      if (itemsRef.current.length >= MAX_DESIGNS) {
        errors.push(`The library holds up to ${MAX_DESIGNS} designs.`);
        break;
      }
      const used = itemsRef.current.reduce((s, d) => s + d.file.size, 0);
      if (used + file.size > MAX_DESIGN_STORE_BYTES) {
        errors.push(`${file.name}: design storage is full (${fmtBytes(MAX_DESIGN_STORE_BYTES)}). Remove a design first.`);
        continue;
      }
      try {
        const bitmap = await decodeDesign(file);
        const thumbBlob = await thumbnail(bitmap);
        const id = ++counter.current;
        const now = Date.now();
        await saveDesign(
          { id, name: file.name, type: file.type, size: file.size, width: bitmap.width, height: bitmap.height, createdAt: now, expiresAt: expiryFor(now), owner: currentOwner() },
          file,
          thumbBlob,
        );
        const item: DesignItem = { id, name: file.name, file, thumb: URL.createObjectURL(thumbBlob), width: bitmap.width, height: bitmap.height };
        itemsRef.current = [...itemsRef.current, item];
        setItems(itemsRef.current);
        if (!activeRef.current) {
          activeRef.current = { id, bitmap };
          setActive(activeRef.current);
        } else bitmap.close();
      } catch (e) {
        errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (errors.length) setError(errors.join(' '));
  }, []);

  const remove = useCallback(
    async (id: number) => {
      const item = itemsRef.current.find((d) => d.id === id);
      if (item) URL.revokeObjectURL(item.thumb);
      const rest = itemsRef.current.filter((d) => d.id !== id);
      itemsRef.current = rest;
      setItems(rest);
      void deleteStoredDesign(id).catch(() => undefined);
      if (activeRef.current?.id === id) {
        activeRef.current.bitmap.close();
        activeRef.current = null;
        setActive(null);
        if (rest[0]) await activate(rest[0].id);
      }
    },
    [activate],
  );

  useEffect(
    () => () => {
      for (const d of itemsRef.current) URL.revokeObjectURL(d.thumb);
      activeRef.current?.bitmap.close();
    },
    [],
  );

  const current = active ? itemsRef.current.find((d) => d.id === active.id) : undefined;
  const activeDesign: ActiveDesign | null = active && current ? { id: active.id, name: current.name, bitmap: active.bitmap, fit } : null;

  return { items, ready, activeId: active?.id ?? null, active: activeDesign, fit, setFit, add, activate, remove, error, clearError: () => setError(undefined) };
}
