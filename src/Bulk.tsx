import { useMemo, useRef, useState } from 'react';
import { getToken, useAuth } from './lib/auth';
import { MAX_BULK_IMAGES, openDriveSink, openZipSink, planJobs, runBulk, type BulkProgress, type BulkResult, type BulkSettings, type ZipSink } from './lib/bulk';
import { driveLink, type DriveFile } from './lib/drive';
import { fmtBytes } from './lib/ingest';
import { parseHexList, SWATCHES, type Edits } from './lib/layers';
import type { FitMode } from './lib/render';
import type { MockupRecord } from './lib/types';
import type { DesignItem } from './lib/useDesigns';

interface Props {
  mockups: MockupRecord[];
  designs: DesignItem[];
  edits: Record<string, Edits>;
  fit: FitMode;
  settings: BulkSettings;
  onChange: (update: (s: BulkSettings) => BulkSettings) => void;
}

const SIZES = [
  { label: 'Original size', value: 0 },
  { label: '3000 px', value: 3000 },
  { label: '2000 px', value: 2000 },
  { label: '1200 px', value: 1200 },
];

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function fmtEta(ms?: number) {
  if (ms === undefined) return '';
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 90 ? `${s}s left` : `${Math.round(s / 60)} min left`;
}

export function Bulk({ mockups, designs, edits, fit, settings, onChange }: Props) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BulkProgress>();
  const [result, setResult] = useState<BulkResult>();
  const [error, setError] = useState<string>();
  const abort = useRef<AbortController>();
  const [driveFile, setDriveFile] = useState<DriveFile>();
  const auth = useAuth();

  // Functional update, so two changes in the same tick can't overwrite each other.
  const set = (p: Partial<BulkSettings>) => onChange((s) => ({ ...s, ...p }));
  const { valid, invalid } = useMemo(() => parseHexList(settings.hexText), [settings.hexText]);

  // Selections are stored as ids; treat anything that no longer exists as unselected.
  const chosenMockups = mockups.filter((m) => settings.mockupIds.includes(m.id));
  const chosenDesigns = designs.filter((d) => settings.designIds.includes(d.id));
  const plan = useMemo(
    () => planJobs(chosenMockups, chosenDesigns, valid, settings.includeOriginal, settings.format, settings.groupByDesign),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chosenMockups.map((m) => m.id).join(), chosenDesigns.map((d) => d.id).join(), valid.join(), settings.includeOriginal, settings.format, settings.groupByDesign],
  );
  const total = plan.jobs.length;
  const usable = chosenMockups.filter((m) => m.designTargetId).length;
  const colorCount = valid.length + (settings.includeOriginal || valid.length === 0 ? 1 : 0);
  const tooMany = total > MAX_BULK_IMAGES;
  const canRun = total > 0 && !tooMany && !running;

  const addSwatch = (hex: string) => {
    const has = valid.includes(hex);
    const text = has
      ? settings.hexText
          .split(/[\s,;]+/)
          .filter((t) => t && t.toLowerCase().replace(/^#/, '') !== hex.slice(1))
          .join(', ')
      : (settings.hexText.trim() ? settings.hexText.trim().replace(/[,\s]*$/, '') + ', ' : '') + hex;
    set({ hexText: text });
  };

  const start = async () => {
    setError(undefined);
    setResult(undefined);
    setDriveFile(undefined);
    let sink: ZipSink;
    const zipName = `reskin-mockups-${new Date().toISOString().slice(0, 10)}.zip`;
    try {
      if (settings.destination === 'drive') {
        if (!auth.account) throw new Error('Sign in with Google to save to Drive.');
        await getToken(); // may open Google's popup, so it has to happen straight from the click
        sink = await openDriveSink(zipName);
      } else {
        // Opens the save dialog, so it has to run directly in the click handler.
        sink = await openZipSink(zipName);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    const ctl = new AbortController();
    abort.current = ctl;
    setRunning(true);
    setProgress({ done: 0, total, current: '', failed: 0 });
    try {
      setResult(
        await runBulk({
          jobs: plan.jobs,
          editsMap: edits,
          format: settings.format,
          longEdge: settings.longEdge,
          fit,
          sink,
          signal: ctl.signal,
          onProgress: setProgress,
        }),
      );
      setDriveFile(sink.file);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      abort.current = undefined;
    }
  };

  return (
    <div className="bulk">
      <section>
        <h3>Mockups</h3>
        {mockups.length === 0 ? (
          <p className="hint">Add PSD mockups in the Library first.</p>
        ) : (
          <ul className="pick">
            {mockups.map((m) => (
              <li key={m.id}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={settings.mockupIds.includes(m.id)}
                    disabled={!m.designTargetId}
                    onChange={() => set({ mockupIds: toggle(settings.mockupIds, m.id) })}
                  />
                  <span />
                </label>
                <span className="pick-name" title={m.name}>
                  {m.name}
                </span>
                {!m.designTargetId && <span className="pick-note">no design area</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Colors</h3>
        <textarea
          className="hex-list"
          rows={3}
          spellCheck={false}
          value={settings.hexText}
          onChange={(e) => set({ hexText: e.target.value })}
          placeholder="#1d4ed8, #d62828, 111111&#10;One per line or separated by commas"
          aria-label="HEX colors"
        />
        <div className="chips" aria-live="polite">
          {valid.map((hex) => (
            <span key={hex} className="chip-color">
              <i style={{ background: hex }} />
              {hex.slice(1).toUpperCase()}
            </span>
          ))}
          {invalid.map((t) => (
            <span key={t} className="chip-color bad" title="Not a HEX color, ignored">
              {t}
            </span>
          ))}
        </div>
        <div className="swatches" role="group" aria-label="Add preset colors">
          {SWATCHES.map((hex) => (
            <button
              key={hex}
              className={`sw${valid.includes(hex) ? ' on' : ''}`}
              style={{ background: hex }}
              title={hex}
              aria-label={`${valid.includes(hex) ? 'Remove' : 'Add'} ${hex}`}
              aria-pressed={valid.includes(hex)}
              onClick={() => addSwatch(hex)}
            />
          ))}
        </div>
        <label className="opt">
          <span className="check">
            <input type="checkbox" checked={settings.includeOriginal} onChange={(e) => set({ includeOriginal: e.target.checked })} />
            <span />
          </span>
          Also export the mockup's own color
        </label>
      </section>

      <section>
        <div className="row-between">
          <h3>Designs</h3>
          {designs.length > 0 && (
            <button className="link" onClick={() => set({ designIds: settings.designIds.length === designs.length ? [] : designs.map((d) => d.id) })}>
              {settings.designIds.length === designs.length ? 'Select none' : 'Select all'}
            </button>
          )}
        </div>
        {designs.length === 0 ? (
          <p className="hint">Add designs in the Designs section below.</p>
        ) : (
          <ul className="pick designs">
            {designs.map((d) => (
              <li key={d.id}>
                <label className="check">
                  <input type="checkbox" checked={settings.designIds.includes(d.id)} onChange={() => set({ designIds: toggle(settings.designIds, d.id) })} />
                  <span />
                </label>
                <img src={d.thumb} alt="" draggable={false} />
                <span className="pick-name" title={d.name}>
                  {d.name}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Output</h3>
        <div className="export-row">
          <div className="segmented" role="radiogroup" aria-label="Format">
            {(['png', 'jpg', 'webp'] as const).map((f) => (
              <button key={f} role="radio" aria-checked={settings.format === f} className={settings.format === f ? 'on' : ''} onClick={() => set({ format: f })}>
                {f.toUpperCase()}
              </button>
            ))}
          </div>
          <select value={settings.longEdge} onChange={(e) => set({ longEdge: Number(e.target.value) })} aria-label="Size">
            {SIZES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="dest" role="radiogroup" aria-label="Save to">
          <span className="dest-label">Save to</span>
          <div className="segmented">
            <button role="radio" aria-checked={settings.destination === 'device'} className={settings.destination === 'device' ? 'on' : ''} onClick={() => set({ destination: 'device' })}>
              This computer
            </button>
            <button
              role="radio"
              aria-checked={settings.destination === 'drive'}
              className={settings.destination === 'drive' ? 'on' : ''}
              disabled={!auth.account}
              title={auth.account ? 'Upload the zip to a "Reskin Mockups" folder in your Google Drive' : 'Sign in with Google to save to Drive'}
              onClick={() => set({ destination: 'drive' })}
            >
              Google Drive
            </button>
          </div>
        </div>
        <label className="opt">
          <span className="check">
            <input type="checkbox" checked={settings.groupByDesign} onChange={(e) => set({ groupByDesign: e.target.checked })} />
            <span />
          </span>
          Put each design in its own folder
        </label>
      </section>

      {plan.notes.length > 0 && (
        <ul className="notes">
          {plan.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      <section className="run">
        <div className="summary">
          {total > 0 ? (
            <>
              <strong>{total}</strong> image{total === 1 ? '' : 's'}
              <span>
                {' '}
                = {usable} mockup{usable === 1 ? '' : 's'} × {chosenDesigns.length} design{chosenDesigns.length === 1 ? '' : 's'} × {colorCount} color{colorCount === 1 ? '' : 's'}
              </span>
            </>
          ) : (
            <span>Pick at least one mockup and one design.</span>
          )}
        </div>
        {tooMany && <p className="sub err">Up to {MAX_BULK_IMAGES} images per batch. Remove a design or a color.</p>}

        {running && progress ? (
          <div className="progress" role="status" aria-live="polite">
            <div className="bar">
              <div style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
            </div>
            <div className="sub">
              {progress.done} of {progress.total} {fmtEta(progress.etaMs) && `· ${fmtEta(progress.etaMs)}`}
              {progress.failed > 0 && ` · ${progress.failed} failed`}
            </div>
            <div className="sub cur" title={progress.current}>
              {progress.done >= progress.total ? (settings.destination === 'drive' ? 'Finishing the Drive upload…' : 'Finishing the zip…') : progress.current}
            </div>
            <button className="btn" onClick={() => abort.current?.abort()}>
              Stop and save what's done
            </button>
          </div>
        ) : (
          <button className="btn accent" onClick={start} disabled={!canRun}>
            Export {total > 0 ? `${total} image${total === 1 ? '' : 's'}` : ''} as ZIP
          </button>
        )}

        {result && (
          <div className="done" role="status">
            {result.cancelled ? 'Stopped. ' : 'Done. '}
            Saved {result.done} image{result.done === 1 ? '' : 's'} ({fmtBytes(result.bytes)}) {driveFile ? 'in a zip in your Drive' : 'to the zip'}
            {result.failed.length > 0 && `, ${result.failed.length} failed (see errors.txt inside)`}.
            {driveFile && (
              <>
                {' '}
                <a href={driveLink(driveFile)} target="_blank" rel="noopener noreferrer">
                  Open in Drive
                </a>
              </>
            )}
          </div>
        )}
        {error && (
          <div className="sub err" role="alert">
            {error}
          </div>
        )}
        <p className="hint">
          {settings.destination === 'drive'
            ? 'Images are made in your browser and uploaded straight to your own Drive.'
            : 'Runs in your browser. Nothing is uploaded.'}
        </p>
      </section>
    </div>
  );
}
