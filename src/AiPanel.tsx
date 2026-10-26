import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { AI_SPACES, AiError, editImage, FALLBACK_MODELS, getKey, getSavedModel, listImageModels, openInAiSpace, saveKey, saveModel, type AiModel } from './lib/ai';
import { useAuth } from './lib/auth';
import { driveLink, uploadBlob, type DriveFile } from './lib/drive';
import { download } from './lib/export';

const IDEAS = ['Make the fabric look like heavy cotton with visible stitching', 'Add soft window light from the left', 'Put it on a wooden table instead'];

interface Props {
  /** Renders the current mockup (design and edits applied) as an image of the given type. */
  render: (format: 'jpg' | 'png') => Promise<Blob>;
  name: string;
}

interface Outcome {
  before: string;
  after?: string;
  afterBlob?: Blob;
  text: string;
  prompt: string;
}

export function AiPanel({ render, name }: Props) {
  const auth = useAuth();
  const saved = getKey();
  const [key, setKey] = useState(saved.key);
  const [remember, setRemember] = useState(saved.remembered);
  const [editingKey, setEditingKey] = useState(!saved.key);
  const [models, setModels] = useState<AiModel[]>(FALLBACK_MODELS);
  const [modelId, setModelId] = useState(getSavedModel() ?? FALLBACK_MODELS[0].id);
  const [keyState, setKeyState] = useState<'idle' | 'checking' | 'ok'>('idle');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState<Outcome>();
  const [spaceNote, setSpaceNote] = useState<string>();
  const [menu, setMenu] = useState(false);
  const abort = useRef<AbortController>();
  const menuRoot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRoot.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  useEffect(
    () => () => {
      if (outcome) {
        URL.revokeObjectURL(outcome.before);
        if (outcome.after) URL.revokeObjectURL(outcome.after);
      }
    },
    [outcome],
  );

  const model = models.find((m) => m.id === modelId) ?? models[0];

  const checkKey = async () => {
    setError(undefined);
    setKeyState('checking');
    try {
      const list = await listImageModels(key.trim());
      setModels(list);
      const pick = list.find((m) => m.id === modelId) ?? list[0];
      setModelId(pick.id);
      saveKey(key.trim(), remember);
      setKeyState('ok');
      setEditingKey(false);
    } catch (e) {
      setKeyState('idle');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async () => {
    setError(undefined);
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const input = await render('jpg');
      const result = await editImage({ key: key.trim(), model, prompt, image: input, signal: ctl.signal });
      setOutcome({
        before: URL.createObjectURL(input),
        after: result.image ? URL.createObjectURL(result.image) : undefined,
        afterBlob: result.image,
        text: result.text,
        prompt,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof AiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      abort.current = undefined;
    }
  };

  const toSpace = async (id: string) => {
    setMenu(false);
    setSpaceNote(undefined);
    try {
      const space = AI_SPACES.find((s) => s.id === id)!;
      const png = await render('png');
      setSpaceNote(await openInAiSpace(space, png, `${name}.png`, download));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const hasKey = key.trim().length > 0 && !editingKey;

  return (
    <section className="ai">
      <h3>AI edit</h3>

      {!hasKey ? (
        <div className="ai-key">
          <label className="hint" htmlFor="gem-key">
            Paste a Gemini API key. Get a free one at{' '}
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
              aistudio.google.com/apikey
            </a>
            .
          </label>
          <div className="export-row">
            <input
              id="gem-key"
              className="hex key-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="AIza…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && key.trim() && void checkKey()}
            />
            <button className="btn" onClick={checkKey} disabled={!key.trim() || keyState === 'checking'}>
              {keyState === 'checking' ? 'Checking…' : 'Save key'}
            </button>
          </div>
          <label className="opt">
            <span className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span />
            </span>
            Remember on this device
          </label>
          <p className="hint">The key stays in your browser and is only sent to Google. Unchecked, it is forgotten when you close this tab.</p>
        </div>
      ) : (
        <>
          <textarea
            className="hex-list"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the one thing to change, e.g. “make the shirt collar ribbed and slightly worn”"
            aria-label="What should change"
            maxLength={600}
          />
          <div className="chips">
            {IDEAS.map((idea) => (
              <button key={idea} className="chip-btn" onClick={() => setPrompt(idea)}>
                {idea}
              </button>
            ))}
          </div>
          <div className="export-row">
            <select value={modelId} onChange={(e) => (setModelId(e.target.value), saveModel(e.target.value))} aria-label="Model">
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <button className="link" onClick={() => setEditingKey(true)}>
              Change key
            </button>
          </div>
          {busy ? (
            <button className="btn" onClick={() => abort.current?.abort()}>
              Working… Cancel
            </button>
          ) : (
            <button className="btn accent" onClick={run} disabled={!prompt.trim()}>
              Edit with Gemini
            </button>
          )}
          <p className="hint">Sends this mockup and your request to Google using your key. The edited image is a flat picture, so layers and colors can't be changed afterwards.</p>
        </>
      )}

      <div className="space" ref={menuRoot}>
        <button className="btn" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu}>
          Edit in your AI space ▾
        </button>
        {menu && (
          <div className="menu up" role="menu">
            {AI_SPACES.map((s) => (
              <button key={s.id} role="menuitem" onClick={() => void toSpace(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {spaceNote && (
        <div className="done" role="status">
          {spaceNote}
        </div>
      )}
      {error && (
        <div className="sub err" role="alert">
          {error}
        </div>
      )}

      {outcome && (
        <Modal title="AI edit" wide onClose={() => setOutcome(undefined)}>
          <p className="prompt-echo">“{outcome.prompt}”</p>
          {outcome.after ? (
            <div className="ba">
              <figure>
                <img src={outcome.before} alt="Before" />
                <figcaption>Before</figcaption>
              </figure>
              <figure>
                <img src={outcome.after} alt="After" />
                <figcaption>After</figcaption>
              </figure>
            </div>
          ) : (
            <p>{outcome.text}</p>
          )}
          {outcome.after && outcome.text && <p className="hint">{outcome.text}</p>}
          <ResultActions outcome={outcome} name={name} signedIn={!!auth.account} onRetry={() => (setOutcome(undefined), void run())} />
        </Modal>
      )}
    </section>
  );
}

function ResultActions({ outcome, name, signedIn, onRetry }: { outcome: Outcome; name: string; signedIn: boolean; onRetry: () => void }) {
  const [driveBusy, setDriveBusy] = useState(false);
  const [file, setFile] = useState<DriveFile>();
  const [err, setErr] = useState<string>();
  const blob = outcome.afterBlob;
  const ext = blob?.type.includes('jpeg') ? 'jpg' : blob?.type.includes('webp') ? 'webp' : 'png';
  const filename = `${name}_ai.${ext}`;

  return (
    <div className="result-actions">
      {blob && (
        <>
          <button className="btn accent" onClick={() => download(blob, filename)}>
            Download
          </button>
          {signedIn && (
            <button
              className="btn"
              disabled={driveBusy}
              onClick={async () => {
                setDriveBusy(true);
                setErr(undefined);
                try {
                  setFile(await uploadBlob(blob, filename));
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e));
                } finally {
                  setDriveBusy(false);
                }
              }}
            >
              {driveBusy ? 'Saving…' : 'Save to Drive'}
            </button>
          )}
        </>
      )}
      <button className="btn" onClick={onRetry}>
        Try again
      </button>
      {file && (
        <a href={driveLink(file)} target="_blank" rel="noopener noreferrer">
          Open in Drive
        </a>
      )}
      {err && (
        <div className="sub err" role="alert">
          {err}
        </div>
      )}
    </div>
  );
}
