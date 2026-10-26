/**
 * AI editing with the user's own Gemini API key. Calls go from the browser straight to Google: nothing passes
 * through any server of ours, and the key is only ever sent to generativelanguage.googleapis.com.
 */
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const KEY_STORE = 'reskin.geminiKey';
const MODEL_STORE = 'reskin.geminiModel';

export type AiApi = 'generateContent' | 'interactions';

export interface AiModel {
  id: string;
  label: string;
  api: AiApi;
}

/** Used until the key's real model list has been fetched. */
export const FALLBACK_MODELS: AiModel[] = [{ id: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image', api: 'generateContent' }];

// --- key storage -----------------------------------------------------------------------------------------------

export function getKey(): { key: string; remembered: boolean } {
  try {
    const session = sessionStorage.getItem(KEY_STORE);
    if (session) return { key: session, remembered: false };
    const local = localStorage.getItem(KEY_STORE);
    if (local) return { key: local, remembered: true };
  } catch {
    /* storage blocked */
  }
  return { key: '', remembered: false };
}

/** Kept for this tab only unless the user opts in to remembering it on this device. */
export function saveKey(key: string, remember: boolean) {
  try {
    sessionStorage.removeItem(KEY_STORE);
    localStorage.removeItem(KEY_STORE);
    if (!key) return;
    (remember ? localStorage : sessionStorage).setItem(KEY_STORE, key);
  } catch {
    /* storage blocked: the key lives in memory for this session */
  }
}

export function getSavedModel(): string | undefined {
  try {
    return localStorage.getItem(MODEL_STORE) ?? undefined;
  } catch {
    return undefined;
  }
}
export function saveModel(id: string) {
  try {
    localStorage.setItem(MODEL_STORE, id);
  } catch {
    /* ignore */
  }
}

// --- API -------------------------------------------------------------------------------------------------------

export class AiError extends Error {
  constructor(
    message: string,
    public kind: 'key' | 'quota' | 'model' | 'blocked' | 'network' | 'other' = 'other',
  ) {
    super(message);
  }
}

async function failure(res: Response): Promise<AiError> {
  let msg = '';
  try {
    const j = await res.json();
    msg = (Array.isArray(j) ? j[0] : j)?.error?.message ?? '';
  } catch {
    /* no body */
  }
  if (res.status === 400 && /api key/i.test(msg)) return new AiError('Google rejected that API key. Check it and try again.', 'key');
  if (res.status === 401 || res.status === 403) return new AiError(`Google refused the request${msg ? `: ${msg}` : '. This key may not have access to image models.'}`, 'key');
  if (res.status === 404) return new AiError('That model is not available to this key. Pick another model.', 'model');
  if (res.status === 429) return new AiError('Google says this key has hit its limit. Wait a bit, or check your plan and quota.', 'quota');
  return new AiError(`Google returned an error (${res.status})${msg ? `: ${msg}` : ''}`);
}

async function call(path: string, key: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      signal,
      headers: { 'x-goog-api-key': key, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new AiError("Couldn't reach Google. Check your connection.", 'network');
  }
}

interface ModelInfo {
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

/**
 * Asks Google which image-capable models this key can use. Doubles as a key check: a bad key fails here with
 * a clear message instead of halfway through an edit.
 */
export async function listImageModels(key: string): Promise<AiModel[]> {
  const res = await call('/models?pageSize=200', key);
  if (!res.ok) throw await failure(res);
  const { models = [] } = (await res.json()) as { models?: ModelInfo[] };
  const found = models
    .filter((m) => /image/i.test(m.name) && !/imagen|embedding/i.test(m.name))
    .map<AiModel>((m) => {
      const methods = m.supportedGenerationMethods ?? [];
      return {
        id: m.name.replace(/^models\//, ''),
        label: m.displayName || m.name.replace(/^models\//, ''),
        // Newer models may only be offered through the Interactions API.
        api: methods.length && !methods.includes('generateContent') ? 'interactions' : 'generateContent',
      };
    });
  return found.length ? found : FALLBACK_MODELS;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(data: string, mime: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Pulls images and text out of either response shape without depending on exact nesting. */
export function extractResult(json: unknown): { images: Blob[]; text: string } {
  const images: Blob[] = [];
  const texts: string[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) return v.forEach(walk);
    const o = v as Record<string, unknown>;
    const inline = (o.inlineData ?? o.inline_data) as { data?: string; mimeType?: string; mime_type?: string } | undefined;
    if (inline?.data) images.push(base64ToBlob(inline.data, inline.mimeType ?? inline.mime_type ?? 'image/png'));
    else if (o.type === 'image' && typeof o.data === 'string') images.push(base64ToBlob(o.data, String(o.mime_type ?? o.mimeType ?? 'image/png')));
    else if ((o.type === 'text' || o.type === undefined) && typeof o.text === 'string' && o.text.trim()) texts.push(o.text.trim());
    for (const child of Object.values(o)) walk(child);
  };
  walk(json);
  return { images, text: texts.join('\n') };
}

function blockReason(json: unknown): string | undefined {
  const j = json as { promptFeedback?: { blockReason?: string }; candidates?: { finishReason?: string }[] };
  if (j?.promptFeedback?.blockReason) return j.promptFeedback.blockReason;
  const fr = j?.candidates?.[0]?.finishReason;
  return fr && !['STOP', 'MAX_TOKENS'].includes(fr) ? fr : undefined;
}

/** Keeps the edit narrow: change what was asked, leave the rest of the mockup alone. */
export function buildPrompt(userPrompt: string): string {
  return (
    'This is a product mockup image. Apply only the following change and keep everything else exactly as it is ' +
    '(composition, camera angle, lighting, background, and the placement and look of any printed design): ' +
    userPrompt.trim()
  );
}

export interface AiEditResult {
  image?: Blob;
  /** Anything the model said instead of (or alongside) an image. */
  text: string;
}

export async function editImage(opts: { key: string; model: AiModel; prompt: string; image: Blob; signal?: AbortSignal }): Promise<AiEditResult> {
  const { key, model, prompt, image, signal } = opts;
  const data = await blobToBase64(image);
  const mime = image.type || 'image/jpeg';
  const text = buildPrompt(prompt);

  const res =
    model.api === 'interactions'
      ? await call(
          '/interactions',
          key,
          {
            method: 'POST',
            body: JSON.stringify({
              model: model.id,
              input: [
                { type: 'text', text },
                { type: 'image', mime_type: mime, data },
              ],
            }),
          },
          signal,
        )
      : await call(
          `/models/${encodeURIComponent(model.id)}:generateContent`,
          key,
          {
            method: 'POST',
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text }, { inline_data: { mime_type: mime, data } }] }],
              generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
            }),
          },
          signal,
        );
  if (!res.ok) throw await failure(res);

  const json = await res.json();
  const { images, text: said } = extractResult(json);
  if (!images.length) {
    const why = blockReason(json);
    if (why) throw new AiError(`Google declined to edit this image (${why.toLowerCase().replace(/_/g, ' ')}). Try rewording the request.`, 'blocked');
    return { text: said || 'The model returned no image. Try describing the change more specifically.' };
  }
  return { image: images[images.length - 1], text: said };
}

// --- "Edit in your AI space" -----------------------------------------------------------------------------------

export interface AiSpace {
  id: string;
  label: string;
  url: string;
}

export const AI_SPACES: AiSpace[] = [
  { id: 'gemini', label: 'Gemini', url: 'https://gemini.google.com/app' },
  { id: 'chatgpt', label: 'ChatGPT', url: 'https://chatgpt.com/' },
  { id: 'claude', label: 'Claude', url: 'https://claude.ai/new' },
  { id: 'copilot', label: 'Microsoft Copilot', url: 'https://copilot.microsoft.com/' },
  { id: 'firefly', label: 'Adobe Firefly', url: 'https://firefly.adobe.com/' },
];

/**
 * Hands the image off to another AI tool. Websites can't attach a file to someone else's chat, so we copy the image
 * to the clipboard (paste it into the chat), also save it as a file (drag it in), and open the site.
 */
export async function openInAiSpace(space: AiSpace, png: Blob, filename: string, save: (b: Blob, n: string) => void): Promise<string> {
  let copied = false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    copied = true;
  } catch {
    /* clipboard images need a secure context and permission */
  }
  save(png, filename);
  window.open(space.url, '_blank', 'noopener');
  return copied
    ? `Image copied and saved as ${filename}. In ${space.label}, press Ctrl+V to paste it, then describe your change.`
    : `Image saved as ${filename}. In ${space.label}, drag it into the chat, then describe your change.`;
}
