import { useEffect, useMemo, useState } from 'react';
import { AiPanel } from './AiPanel';
import { useAuth } from './lib/auth';
import { driveLink, uploadBlob, type DriveFile } from './lib/drive';
import { download, exportMockup, exportName, sizeChoices, type ExportFormat } from './lib/export';
import {
  colorLayers,
  emptyEdits,
  type DesignBlend,
  flattenLayers,
  isEdited,
  normalizeHex,
  primaryColorLayer,
  SWATCHES,
  type Edits,
  type FlatLayer,
} from './lib/layers';
import type { Design } from './lib/render';
import type { MockupRecord } from './lib/types';

interface Props {
  rec: MockupRecord;
  edits: Edits | undefined;
  design: (Design & { name: string }) | null;
  onChange: (edits: Edits) => void;
  onBack: () => void;
}

function HexField({ value, onCommit, label }: { value: string; onCommit: (hex: string) => void; label: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const valid = normalizeHex(text) !== null;
  return (
    <input
      className={`hex${valid ? '' : ' invalid'}`}
      value={text}
      spellCheck={false}
      maxLength={7}
      aria-label={label}
      aria-invalid={!valid}
      onChange={(e) => {
        setText(e.target.value);
        const hex = normalizeHex(e.target.value);
        if (hex) onCommit(hex);
      }}
      onBlur={() => setText(value)}
    />
  );
}

function ColorRow({
  f,
  edits,
  primary,
  onColor,
  onVisible,
}: {
  f: FlatLayer;
  edits: Edits;
  primary: boolean;
  onColor: (hex: string) => void;
  onVisible: (v: boolean) => void;
}) {
  const color = edits.colors[f.path] ?? f.layer.fillColor ?? '#000000';
  const visible = edits.visible[f.path] ?? f.layer.visible;
  return (
    <div className={`color-row${primary ? ' primary' : ''}${visible ? '' : ' off'}`}>
      <label className="check" title={visible ? 'Hide this color layer' : 'Show this color layer'}>
        <input type="checkbox" checked={visible} onChange={(e) => onVisible(e.target.checked)} aria-label={`Show ${f.layer.name}`} />
        <span />
      </label>
      <input className="swatch-input" type="color" value={color} onChange={(e) => onColor(e.target.value)} aria-label={`${f.layer.name} color`} />
      <HexField value={color} onCommit={onColor} label={`${f.layer.name} hex`} />
      <span className="color-name" title={f.layer.name}>
        {f.layer.name}
      </span>
    </div>
  );
}

export function Editor({ rec, edits: editsProp, design, onChange, onBack }: Props) {
  const edits = editsProp ?? emptyEdits();
  const fills = useMemo(() => colorLayers(rec), [rec]);
  const primary = useMemo(() => primaryColorLayer(rec), [rec]);
  const layers = useMemo(() => flattenLayers(rec.layers), [rec]);
  const sizes = useMemo(() => sizeChoices(rec), [rec]);
  const [format, setFormat] = useState<ExportFormat>('png');
  const [sizeIdx, setSizeIdx] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => setSizeIdx(0), [rec.id]);

  const setColor = (path: string, hex: string) =>
    onChange({ ...edits, colors: { ...edits.colors, [path]: hex }, visible: { ...edits.visible, [path]: true } });
  const setVisible = (path: string, v: boolean) => onChange({ ...edits, visible: { ...edits.visible, [path]: v } });
  const setOpacity = (path: string, v: number) => onChange({ ...edits, opacity: { ...edits.opacity, [path]: v } });

  const auth = useAuth();
  const [driveFile, setDriveFile] = useState<DriveFile>();

  const doExport = async (toDrive = false) => {
    setExporting(true);
    setError(undefined);
    setDriveFile(undefined);
    try {
      const size = sizes[sizeIdx] ?? sizes[0];
      const blob = await exportMockup(rec, design ? { bitmap: design.bitmap, fit: design.fit } : null, editsProp, {
        format,
        longEdge: size.longEdge,
      });
      const name = exportName(rec, design?.name, editsProp, format);
      if (toDrive) setDriveFile(await uploadBlob(blob, name));
      else download(blob, name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const others = fills.filter((f) => f.path !== primary?.path);

  return (
    <div className="editor">
      <div className="pane-head">
        <button className="link back" onClick={onBack}>
          ‹ Library
        </button>
        {isEdited(editsProp) && (
          <button className="link" onClick={() => onChange(emptyEdits())}>
            Reset changes
          </button>
        )}
      </div>
      <div className="editor-title" title={rec.name}>
        {rec.name}
      </div>

      <section>
        <h3>Color</h3>
        {fills.length === 0 ? (
          <p className="hint">This mockup has no solid-color layers to recolor. Its layers are listed below.</p>
        ) : (
          <>
            {primary && (
              <>
                <ColorRow
                  f={primary}
                  edits={edits}
                  primary
                  onColor={(hex) => setColor(primary.path, hex)}
                  onVisible={(v) => setVisible(primary.path, v)}
                />
                <div className="swatches" role="group" aria-label="Preset colors">
                  {SWATCHES.map((hex) => (
                    <button
                      key={hex}
                      className={`sw${edits.colors[primary.path] === hex ? ' on' : ''}`}
                      style={{ background: hex }}
                      title={hex}
                      aria-label={`Use ${hex}`}
                      onClick={() => setColor(primary.path, hex)}
                    />
                  ))}
                </div>
              </>
            )}
            {others.length > 0 && (
              <details className="more" open={!primary}>
                <summary>{primary ? 'Other color layers' : 'Color layers'}</summary>
                {others.map((f) => (
                  <ColorRow
                    key={f.path}
                    f={f}
                    edits={edits}
                    primary={false}
                    onColor={(hex) => setColor(f.path, hex)}
                    onVisible={(v) => setVisible(f.path, v)}
                  />
                ))}
              </details>
            )}
          </>
        )}
      </section>

      {rec.designTargetId && (
        <section>
          <h3>Design blend</h3>
          <div className="segmented" role="radiogroup" aria-label="Design blend">
            {(
              [
                ['auto', 'Auto'],
                ['psd', 'As in PSD'],
                ['normal', 'Normal'],
                ['multiply', 'Multiply'],
              ] as [DesignBlend, string][]
            ).map(([v, label]) => (
              <button
                key={v}
                role="radio"
                aria-checked={(edits.designBlend ?? 'auto') === v}
                className={(edits.designBlend ?? 'auto') === v ? 'on' : ''}
                onClick={() => onChange({ ...edits, designBlend: v })}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="hint">Auto keeps the PSD's look on a white product and prints the design normally on colored ones.</p>
        </section>
      )}

      <section>
        <details className="more">
          <summary>Layers ({layers.length})</summary>
          <ul className="layer-list">
            {layers.map((f) => {
              const visible = edits.visible[f.path] ?? f.layer.visible;
              const opacity = edits.opacity[f.path] ?? f.layer.opacity;
              const leaf = !f.layer.children;
              return (
                <li key={f.path} style={{ paddingLeft: f.depth * 14 }} className={visible ? '' : 'off'}>
                  <label className="check" title={visible ? 'Hide layer' : 'Show layer'}>
                    <input type="checkbox" checked={visible} onChange={(e) => setVisible(f.path, e.target.checked)} aria-label={`Show ${f.layer.name}`} />
                    <span />
                  </label>
                  <span className="lname" title={`${f.layer.name} · ${f.layer.blendMode}`}>
                    {f.layer.name}
                  </span>
                  {leaf && f.layer.fillOpacity > 0 && (
                    <input
                      className="opacity"
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(opacity * 100)}
                      onChange={(e) => setOpacity(f.path, Number(e.target.value) / 100)}
                      aria-label={`${f.layer.name} opacity`}
                      title={`Opacity ${Math.round(opacity * 100)}%`}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      </section>

      <AiPanel
        name={exportName(rec, design?.name, editsProp, 'png').replace(/[.]png$/, '')}
        render={(f) => exportMockup(rec, design ? { bitmap: design.bitmap, fit: design.fit } : null, editsProp, { format: f, longEdge: 2048 })}
      />

      <section className="export">
        <h3>Export</h3>
        <div className="export-row">
          <div className="segmented" role="radiogroup" aria-label="Format">
            {(['png', 'jpg', 'webp'] as const).map((f) => (
              <button key={f} role="radio" aria-checked={format === f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>
                {f.toUpperCase()}
              </button>
            ))}
          </div>
          <select value={sizeIdx} onChange={(e) => setSizeIdx(Number(e.target.value))} aria-label="Size">
            {sizes.map((s, i) => (
              <option key={s.label} value={i}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        {!design && rec.designTargetId && <p className="hint">No design added yet, so this exports the placeholder.</p>}
        <div className="export-row">
          <button className="btn accent" onClick={() => doExport(false)} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Export image'}
          </button>
          {auth.account && (
            <button className="btn" onClick={() => doExport(true)} disabled={exporting} title='Upload to the "Reskin Mockups" folder in your Google Drive'>
              Save to Drive
            </button>
          )}
        </div>
        {driveFile && (
          <div className="done" role="status">
            Saved to Drive.{' '}
            <a href={driveLink(driveFile)} target="_blank" rel="noopener noreferrer">
              Open
            </a>
          </div>
        )}
        {error && (
          <div className="sub err" role="alert">
            {error}
          </div>
        )}
      </section>
    </div>
  );
}
