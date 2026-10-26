import { useRef, useState } from 'react';
import { DESIGN_EXT } from './lib/design';
import { MAX_DESIGNS, type useDesigns } from './lib/useDesigns';

type Designs = ReturnType<typeof useDesigns>;

const UPLOAD =
  'M8 1.5a.5.5 0 0 1 .35.15l3 3a.5.5 0 1 1-.7.7L8.5 3.21V10a.5.5 0 0 1-1 0V3.2L5.35 5.35a.5.5 0 1 1-.7-.7l3-3A.5.5 0 0 1 8 1.5ZM2.5 11a.5.5 0 0 1 .5.5v1c0 .28.22.5.5.5h9a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 1 1 0v1c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-1a.5.5 0 0 1 .5-.5Z';

export function DesignPanel({ designs }: { designs: Designs }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const { items, activeId, fit, setFit, add, activate, remove, error } = designs;

  return (
    <section className="design" aria-label="Designs">
      <div className="pane-head">
        <h2>Designs</h2>
        {items.length > 0 && (
          <span className="count">
            {items.length}/{MAX_DESIGNS}
          </span>
        )}
      </div>

      {items.length > 0 && (
        <ul className="design-grid">
          {items.map((d) => (
            <li key={d.id} className={d.id === activeId ? 'active' : ''}>
              <button className="design-thumb" onClick={() => activate(d.id)} title={`${d.name} · ${d.width}×${d.height}`} aria-pressed={d.id === activeId}>
                <img src={d.thumb} alt={d.name} draggable={false} />
              </button>
              <button className="design-x" onClick={() => remove(d.id)} aria-label={`Remove ${d.name}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div
        className={`drop design-drop${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void add(e.dataTransfer.files);
        }}
      >
        <svg viewBox="0 0 16 16" width="24" height="24" aria-hidden="true" fill="currentColor">
          <path d={UPLOAD} />
        </svg>
        <p>
          Drop designs here or{' '}
          <button className="link" onClick={() => input.current?.click()}>
            browse
          </button>
        </p>
        <small>{items.length ? 'Click a design to preview it.' : 'PNG, JPG, WebP or SVG. Transparent PNGs work best.'}</small>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={DESIGN_EXT.join(',')}
          onChange={(e) => {
            if (e.target.files) void add(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {error && (
        <div className="sub err" role="alert">
          {error}
        </div>
      )}

      {items.length > 0 && (
        <div className="segmented" role="radiogroup" aria-label="Design fit">
          {(['contain', 'cover'] as const).map((f) => (
            <button key={f} role="radio" aria-checked={fit === f} className={fit === f ? 'on' : ''} onClick={() => setFit(f)}>
              {f === 'contain' ? 'Fit' : 'Fill'}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
