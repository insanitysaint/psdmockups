import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthButton } from './AuthButton';
import { Bulk } from './Bulk';
import { DesignPanel } from './DesignPanel';
import { Editor } from './Editor';
import { currentAccount, getToken, hasLiveToken, onAuthChange, useAuth } from './lib/auth';
import { backupOriginal } from './lib/backup';
import { defaultBulkSettings, type BulkSettings } from './lib/bulk';
import { useDesigns } from './lib/useDesigns';
import { isEdited, type Edits } from './lib/layers';
import { ingestFile, fmtBytes } from './lib/ingest';
import { MAX_FILES, MAX_STORED_BYTES, GUEST_TTL_MS, PREVIEW_MAX_EDGE } from './lib/limits';
import { renderer } from './lib/render';
import { unsupportedReason } from './lib/support';
import { adoptGuestFiles, deleteMockup, getBlob, getState, listMockups, previewKey, releaseOwnedFiles, setState, sweepExpired } from './lib/store';
import type { IngestProgress, MockupRecord } from './lib/types';

/** Progress of a Drive backup, or why it failed. Keyed by mockup id. */
type BackupStatus = { sent: number; total: number } | { error: string };

interface Job {
  key: string;
  name: string;
  size: number;
  progress?: IngestProgress;
  error?: string;
}

const STAGE_LABEL: Record<IngestProgress['stage'], string> = {
  reading: 'Reading file',
  parsing: 'Parsing layers',
  compressing: 'Compressing layers',
  saving: 'Saving',
};

/** Grid-template-areas for 1 to 10 tiles. */
const BENTO: Record<number, string[]> = {
  1: ['a'],
  2: ['a b'],
  3: ['a b', 'a c'],
  4: ['a b', 'c d'],
  5: ['a a b', 'c d b'],
  6: ['a b c', 'd e f'],
  7: ['a a b c', 'd e f g'],
  8: ['a b c d', 'e f g h'],
  9: ['a b c', 'd e f', 'g h i'],
  10: ['a b c d e', 'f g h i j'],
};

function useStoredPreview(id: string) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let revoked: string | undefined;
    let alive = true;
    getBlob(previewKey(id)).then((b) => {
      if (!alive || !b) return;
      revoked = URL.createObjectURL(b);
      setUrl(revoked);
    });
    return () => {
      alive = false;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [id]);
  return url;
}

function timeLeft(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return 'Kept while signed in';
  const ms = expiresAt - now;
  if (ms <= 0) return 'Deleting…';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `Deletes in ${h}h ${m}m` : `Deletes in ${m}m`;
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d={d} />
    </svg>
  );
}
const I = {
  upload: 'M8 1.5a.5.5 0 0 1 .35.15l3 3a.5.5 0 1 1-.7.7L8.5 3.21V10a.5.5 0 0 1-1 0V3.2L5.35 5.35a.5.5 0 1 1-.7-.7l3-3A.5.5 0 0 1 8 1.5ZM2.5 11a.5.5 0 0 1 .5.5v1c0 .28.22.5.5.5h9a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 1 1 0v1c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-1a.5.5 0 0 1 .5-.5Z',
  close: 'M3.4 2.7a.5.5 0 0 0-.7.7L7.3 8l-4.6 4.6a.5.5 0 0 0 .7.7L8 8.7l4.6 4.6a.5.5 0 0 0 .7-.7L8.7 8l4.6-4.6a.5.5 0 0 0-.7-.7L8 7.3 3.4 2.7Z',
  clock: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM2 8a6 6 0 1 1 12 0A6 6 0 0 1 2 8Zm6-3.5a.5.5 0 0 1 .5.5v2.8l1.85 1.1a.5.5 0 0 1-.5.86l-2.1-1.25A.5.5 0 0 1 7.5 8.2V5a.5.5 0 0 1 .5-.5Z',
  warn: 'M8 1.5a1 1 0 0 1 .87.5l6 10.5a1 1 0 0 1-.87 1.5H2a1 1 0 0 1-.87-1.5L7.13 2A1 1 0 0 1 8 1.5ZM8 5.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 1 0V6a.5.5 0 0 0-.5-.5Zm0 6a.6.6 0 1 0 0-1.2.6.6 0 0 0 0 1.2Z',
};

function Tile({
  m,
  src,
  busy,
  noTarget,
  focused,
  edited,
  onEdit,
}: {
  m: MockupRecord;
  src?: string;
  busy: boolean;
  noTarget: boolean;
  focused: boolean;
  edited: boolean;
  onEdit: () => void;
}) {
  const stored = useStoredPreview(m.id);
  const shown = src ?? stored;
  return (
    <div
      className={`tile${focused ? ' focused' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`Edit ${m.name}`}
      aria-pressed={focused}
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit();
        }
      }}
    >
      {shown ? <img src={shown} alt="" draggable={false} /> : <div className="skeleton" />}
      <span className="tile-label">
        {m.name}
        {edited && ' · edited'}
      </span>
      <span className="tile-edit">Edit</span>
      {busy && <span className="tile-badge">Rendering…</span>}
      {!busy && noTarget && <span className="tile-badge warn">No design area found</span>}
    </div>
  );
}

function Card({
  m,
  now,
  selected,
  backup,
  onToggle,
  onRemove,
  onEdit,
}: {
  m: MockupRecord;
  now: number;
  selected: boolean;
  backup?: BackupStatus;
  onToggle: () => void;
  onRemove: () => void;
  onEdit: () => void;
}) {
  const url = useStoredPreview(m.id);
  const saved = Math.max(0, Math.round((1 - m.storedBytes / m.rawBytes) * 100));
  return (
    <li className={`card${selected ? ' selected' : ''}`}>
      <label className="check" title="Show in preview">
        <input type="checkbox" checked={selected} onChange={onToggle} />
        <span />
      </label>
      <div className="thumb">{url && <img src={url} alt="" draggable={false} />}</div>
      <div className="meta">
        <div className="name" title={m.name}>
          {m.name}
        </div>
        <div className="sub">
          {fmtBytes(m.rawBytes)} → {fmtBytes(m.storedBytes)}
          {saved > 0 && <span className="pill">{saved}% smaller</span>}
        </div>
        <div className="sub">
          {m.width}×{m.height} · {m.layerCount} layers · {m.smartObjectCount} smart object
          {m.smartObjectCount === 1 ? '' : 's'}
        </div>
        {(m.warnings.length > 0 || !m.designTargetId) && (
          <div
            className="sub note"
            title={[!m.designTargetId && 'No smart object to place a design into.', ...m.warnings].filter(Boolean).join('\n')}
          >
            <Icon d={I.warn} />
            {!m.designTargetId ? 'No design area found' : `${m.warnings.length} thing${m.warnings.length === 1 ? '' : 's'} not rendered`}
          </div>
        )}
        <div className="sub expiry">
          <Icon d={I.clock} /> {timeLeft(m.expiresAt, now)}
        </div>
        {backup && 'error' in backup ? (
          <div className="sub err" role="alert">
            Drive backup failed: {backup.error}
          </div>
        ) : backup ? (
          <>
            <div className="sub">
              Backing up to Drive · {fmtBytes(backup.sent)} of {fmtBytes(backup.total)}
            </div>
            <div className="bar slim">
              <div style={{ width: `${Math.round((backup.sent / backup.total) * 100)}%` }} />
            </div>
          </>
        ) : (
          m.backup && (
            <div className="sub">
              Original backed up ·{' '}
              <a href={m.backup.link} target="_blank" rel="noopener noreferrer">
                Open in Drive
              </a>
            </div>
          )
        )}
      </div>
      <div className="card-actions">
        <button className="icon-btn" onClick={onRemove} aria-label={`Remove ${m.name}`} title="Remove">
          <Icon d={I.close} />
        </button>
        <button className="link" onClick={onEdit}>
          Edit
        </button>
      </div>
    </li>
  );
}

export function App() {
  const [mockups, setMockups] = useState<MockupRecord[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(Date.now());
  const designs = useDesigns();
  const design = designs.active;
  const [renders, setRenders] = useState<Record<string, { url: string; version: string }>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [renderError, setRenderError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const queue = useRef<{ key: string; file: File; backup: boolean }[]>([]);
  const [backupOn, setBackupOn] = useState(false);
  const [backups, setBackups] = useState<Record<string, BackupStatus>>({});
  const backupChain = useRef<Promise<void>>(Promise.resolve());
  const rendersRef = useRef(renders);
  rendersRef.current = renders;
  const [tab, setTab] = useState<'library' | 'edit' | 'bulk'>('library');
  const [bulk, setBulk] = useState<BulkSettings>(defaultBulkSettings);
  const [persistLoaded, setPersistLoaded] = useState(false);
  const [mockupsLoaded, setMockupsLoaded] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, Edits>>({});
  const editsRef = useRef(edits);
  editsRef.current = edits;

  const refresh = useCallback(async () => {
    const removed = await sweepExpired();
    const list = await listMockups();
    setMockups(list);
    if (removed.length) setSelected((s) => new Set([...s].filter((id) => !removed.includes(id))));
    return list;
  }, []);

  const auth = useAuth();
  const unsupported = useMemo(() => unsupportedReason(), []);

  // Account changes decide what happens to stored files: signing in keeps them, signing out puts them on the 24h timer.
  useEffect(() => {
    onAuthChange({
      onSignIn: async (email) => {
        await adoptGuestFiles(email);
        await refresh();
      },
      onSignOut: async () => {
        await releaseOwnedFiles(Date.now(), GUEST_TTL_MS);
        await refresh();
      },
    });
  }, [refresh]);

  // Initial load, then sweep expired guest files every 30s and when the tab regains focus.
  useEffect(() => {
    // Files kept for an account that is no longer remembered on this browser must not outlive a guest's 24 hours.
    const start = currentAccount() ? Promise.resolve() : releaseOwnedFiles(Date.now(), GUEST_TTL_MS);
    start
      .then(refresh)
      .then((list) => {
        setSelected(new Set(list.slice(0, MAX_FILES).map((m) => m.id)));
        setMockupsLoaded(true);
      });
    const tick = () => {
      setNow(Date.now());
      refresh();
    };
    const t = setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh]);

  const patchJob = (key: string, p: Partial<Job>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...p } : j)));

  // One upload at a time, so several big PSDs don't fight over the connection.
  const queueBackup = useCallback((id: string, file: File) => {
    backupChain.current = backupChain.current.then(async () => {
      setBackups((b) => ({ ...b, [id]: { sent: 0, total: file.size } }));
      try {
        const info = await backupOriginal(file, id, (sent) => setBackups((b) => ({ ...b, [id]: { sent, total: file.size } })));
        if (info) setMockups((ms) => ms.map((x) => (x.id === id ? { ...x, backup: info } : x)));
        setBackups(({ [id]: _done, ...rest }) => rest);
      } catch (e) {
        setBackups((b) => ({ ...b, [id]: { error: e instanceof Error ? e.message : String(e) } }));
      }
    });
  }, []);

  const drain = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      let next: { key: string; file: File; backup: boolean } | undefined;
      while ((next = queue.current.shift())) {
        const { key, file, backup } = next;
        try {
          const rec = await ingestFile(file, (progress) => patchJob(key, { progress }));
          setJobs((js) => js.filter((j) => j.key !== key));
          setMockups((ms) => [...ms, rec]);
          setSelected((s) => new Set(s).add(rec.id));
          if (backup) queueBackup(rec.id, file);
        } catch (e) {
          patchJob(key, { error: e instanceof Error ? e.message : String(e), progress: undefined });
        }
      }
    } finally {
      busyRef.current = false;
    }
  }, [queueBackup]);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const backup = backupOn && !!auth.account;
      // Refresh the Drive token now, while the click/drop still lets Google's popup open; the upload runs later.
      if (backup && !hasLiveToken()) void getToken().catch(() => undefined);
      // Build jobs outside the state updater: updaters run later (and twice in StrictMode).
      const added: Job[] = [...files].map((f) => {
        const key = crypto.randomUUID();
        queue.current.push({ key, file: f, backup });
        return { key, name: f.name, size: f.size };
      });
      setJobs((js) => [...js, ...added]);
      void drain();
    },
    [drain, backupOn, auth.account],
  );

  // Edits and bulk options come back after a reload.
  useEffect(() => {
    (async () => {
      try {
        const [e, b, bk] = await Promise.all([getState<Record<string, Edits>>('edits'), getState<BulkSettings>('bulk'), getState<boolean>('backupPsd')]);
        if (e) setEdits(e);
        if (bk) setBackupOn(true);
        if (b) setBulk({ ...defaultBulkSettings(), ...b });
      } catch (err) {
        console.warn('Could not restore saved settings', err);
      }
      setPersistLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!persistLoaded) return;
    const t = setTimeout(() => {
      void setState('edits', edits).catch(() => undefined);
      void setState('bulk', bulk).catch(() => undefined);
      void setState('backupPsd', backupOn).catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [edits, bulk, backupOn, persistLoaded]);

  // Edits for mockups that no longer exist (expired or removed) are dropped.
  useEffect(() => {
    if (!persistLoaded || !mockupsLoaded) return;
    setEdits((all) => {
      const keep = Object.keys(all).filter((id) => mockups.some((m) => m.id === id));
      return keep.length === Object.keys(all).length ? all : Object.fromEntries(keep.map((id) => [id, all[id]]));
    });
  }, [mockups, persistLoaded, mockupsLoaded]);

  // New mockups and designs start out selected for bulk export; ones that were removed drop out of the selection.
  // "Known" ids are saved with the settings, so something the user unticked doesn't come back after a reload.
  useEffect(() => {
    if (!persistLoaded || !mockupsLoaded) return;
    setBulk((b) => {
      const fresh = mockups.filter((m) => !b.knownMockups.includes(m.id));
      const ids = [...b.mockupIds.filter((id) => mockups.some((m) => m.id === id)), ...fresh.filter((m) => m.designTargetId).map((m) => m.id)];
      if (!fresh.length && ids.length === b.mockupIds.length) return b;
      return { ...b, mockupIds: ids, knownMockups: [...b.knownMockups, ...fresh.map((m) => m.id)] };
    });
  }, [mockups, persistLoaded, mockupsLoaded]);
  useEffect(() => {
    if (!persistLoaded || !designs.ready) return;
    setBulk((b) => {
      const fresh = designs.items.filter((d) => !b.knownDesigns.includes(d.id));
      const ids = [...b.designIds.filter((id) => designs.items.some((d) => d.id === id)), ...fresh.map((d) => d.id)];
      if (!fresh.length && ids.length === b.designIds.length) return b;
      return { ...b, designIds: ids, knownDesigns: [...b.knownDesigns, ...fresh.map((d) => d.id)] };
    });
  }, [designs.items, designs.ready, persistLoaded]);

  const shown = useMemo(() => mockups.filter((m) => selected.has(m.id)).slice(0, MAX_FILES), [mockups, selected]);
  const designVersion = design ? `${design.id}:${design.fit}` : 'none';

  const editsKey = JSON.stringify(edits);

  // Re-render a previewed mockup whenever the design, its fit, or that mockup's edits change.
  // One at a time (they share a GL context), and briefly debounced so dragging a color picker stays responsive.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      for (const m of shown) {
        if (cancelled) return;
        const mine = editsRef.current[m.id];
        const version = `${designVersion}|${mine ? JSON.stringify(mine) : ''}`;
        if (rendersRef.current[m.id]?.version === version) continue;
        setBusy((b) => new Set(b).add(m.id));
        try {
          const blob = await renderer().render(m, {
            maxEdge: PREVIEW_MAX_EDGE,
            design: design ? { bitmap: design.bitmap, fit: design.fit } : null,
            edits: mine,
          });
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          setRenders((r) => {
            if (r[m.id]) URL.revokeObjectURL(r[m.id].url);
            return { ...r, [m.id]: { url, version } };
          });
          setRenderError(undefined);
        } catch (e) {
          if (!cancelled) setRenderError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy((b) => {
            const n = new Set(b);
            n.delete(m.id);
            return n;
          });
        }
      }
    };
    const timer = setTimeout(run, 90);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.map((m) => m.id).join(','), designVersion, editsKey]);

  const used = useMemo(() => mockups.reduce((s, m) => s + m.storedBytes, 0), [mockups]);
  const areas = BENTO[shown.length];
  const focused = mockups.find((m) => m.id === focusId);
  const letters = 'abcdefghij';

  const removeMockup = async (m: MockupRecord) => {
    await deleteMockup(m.id);
    try {
      renderer().forget(m.id);
    } catch {
      /* no renderer was ever created */
    }
    setRenders((r) => {
      if (r[m.id]) URL.revokeObjectURL(r[m.id].url);
      const { [m.id]: _gone, ...rest } = r;
      return rest;
    });
    setMockups((ms) => ms.filter((x) => x.id !== m.id));
    setBackups(({ [m.id]: _b, ...rest }) => rest);
    setEdits((e) => {
      const { [m.id]: _e, ...rest } = e;
      return rest;
    });
    if (focusId === m.id) {
      setFocusId(null);
      setTab('library');
    }
    setSelected((s) => {
      const n = new Set(s);
      n.delete(m.id);
      return n;
    });
  };

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          <strong>Reskin Mockups</strong>
        </div>
        <div className="spacer" />
        {auth.account ? (
          <span className="chip kept" title="Your uploaded mockups stay until you remove them or sign out.">
            Signed in · files are kept
          </span>
        ) : (
          <span className="chip" title="Files you add are deleted automatically unless you sign in.">
            Guest · files auto-delete after {GUEST_TTL_MS / 3_600_000}h
          </span>
        )}
        <AuthButton />
      </header>

      {unsupported && (
        <div className="banner wide" role="alert">
          {unsupported}
        </div>
      )}

      <main className="workspace">
        <section className="canvas" aria-label="Preview">
          {renderError && (
            <div className="banner" role="alert">
              Live previews are unavailable: {renderError}
            </div>
          )}
          {shown.length === 0 ? (
            <div className="empty">
              <h2>Your mockups appear here</h2>
              <p>Drop PSD files in the panel on the right, then tick the ones you want to preview. Up to 10 at once.</p>
            </div>
          ) : (
            <div
              className="bento"
              style={{
                gridTemplateAreas: areas.map((r) => `"${r.split(' ').map((c) => 'm' + c).join(' ')}"`).join(' '),
              }}
            >
              {shown.map((m, i) => (
                <div key={m.id} style={{ gridArea: 'm' + letters[i] }} className="cell">
                  <Tile
                    m={m}
                    src={renders[m.id]?.url}
                    busy={busy.has(m.id)}
                    noTarget={!!design && !m.designTargetId}
                    focused={tab === 'edit' && focusId === m.id}
                    edited={isEdited(edits[m.id])}
                    onEdit={() => {
                      setFocusId(m.id);
                      setTab('edit');
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="pane" aria-label="Mockup library">
          {tab === 'edit' && focused ? (
            <Editor
              rec={focused}
              edits={edits[focused.id]}
              design={design ? { bitmap: design.bitmap, fit: design.fit, name: design.name } : null}
              onChange={(e) => setEdits((all) => ({ ...all, [focused.id]: e }))}
              onBack={() => setTab('library')}
            />
          ) : (
            <>
          <div className="segmented nav" role="tablist" aria-label="Workspace">
            {(['library', 'bulk'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t === 'library' ? 'Library' : 'Bulk export'}
              </button>
            ))}
          </div>
          {tab === 'bulk' ? (
            <Bulk mockups={mockups} designs={designs.items} edits={edits} fit={designs.fit} settings={bulk} onChange={setBulk} />
          ) : (
            <>
          <div className="pane-head">
            <h2>Mockups</h2>
            <span className="count">
              {mockups.length}/{MAX_FILES}
            </span>
          </div>

          <div className="meter" role="img" aria-label={`${fmtBytes(used)} of ${fmtBytes(MAX_STORED_BYTES)} used`}>
            <div className="bar">
              <div style={{ width: `${Math.min(100, (used / MAX_STORED_BYTES) * 100)}%` }} />
            </div>
            <span>
              {fmtBytes(used)} of {fmtBytes(MAX_STORED_BYTES)} used
            </span>
          </div>

          <div
            className={`drop${dragging ? ' over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              addFiles(e.dataTransfer.files);
            }}
          >
            <Icon d={I.upload} />
            <p>
              Drag PSD files here or{' '}
              <button className="link" onClick={() => input.current?.click()}>
                browse
              </button>
            </p>
            <small>.psd and .psb, up to 2 GB each. We keep a compressed copy under 1 GB total.</small>
            <input
              ref={input}
              type="file"
              accept=".psd,.psb"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {auth.account && (
            <label className="sub backup-toggle" title='Copies each original PSD into a "Reskin Mockups" folder in your Google Drive after it is added'>
              <input type="checkbox" checked={backupOn} onChange={(e) => setBackupOn(e.target.checked)} /> Back up original PSDs to my Google Drive
            </label>
          )}

          <ul className="list">
            {jobs.map((j) => (
              <li key={j.key} className={`card job${j.error ? ' failed' : ''}`}>
                <div className="meta">
                  <div className="name" title={j.name}>
                    {j.name}
                  </div>
                  {j.error ? (
                    <div className="sub err" role="alert">
                      {j.error}
                    </div>
                  ) : (
                    <>
                      <div className="sub">
                        {j.progress ? STAGE_LABEL[j.progress.stage] : 'Waiting'} · {fmtBytes(j.size)}
                      </div>
                      <div className="bar slim">
                        <div
                          className={j.progress ? '' : 'indeterminate'}
                          style={j.progress ? { width: `${Math.round(j.progress.fraction * 100)}%` } : undefined}
                        />
                      </div>
                    </>
                  )}
                </div>
                {j.error && (
                  <button
                    className="icon-btn"
                    aria-label="Dismiss"
                    onClick={() => setJobs((js) => js.filter((x) => x.key !== j.key))}
                  >
                    <Icon d={I.close} />
                  </button>
                )}
              </li>
            ))}
            {mockups.map((m) => (
              <Card
                key={m.id}
                m={m}
                now={now}
                selected={selected.has(m.id)}
                backup={backups[m.id]}
                onToggle={() =>
                  setSelected((s) => {
                    const n = new Set(s);
                    n.has(m.id) ? n.delete(m.id) : n.add(m.id);
                    return n;
                  })
                }
                onRemove={() => removeMockup(m)}
                onEdit={() => {
                  setFocusId(m.id);
                  setTab('edit');
                }}
              />
            ))}
          </ul>
            </>
          )}
            </>
          )}

          <DesignPanel designs={designs} />
        </aside>
      </main>
    </div>
  );
}
