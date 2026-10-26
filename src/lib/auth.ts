import { useSyncExternalStore } from 'react';

/**
 * Google sign-in with Google Identity Services' token model: runs entirely in the browser, no backend.
 * Tokens live in memory only. Only the "drive.file" scope is requested, which limits Drive access to files this
 * app creates, so the app can never read the rest of someone's Drive.
 */
const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim();
const SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.file';
const ACCOUNT_KEY = 'reskin.account';

export interface Account {
  email: string;
  name?: string;
  picture?: string;
}

export interface AuthState {
  account: Account | null;
  /** True when we remember who signed in but have no live Drive token (e.g. after a reload). */
  needsReconnect: boolean;
  busy: boolean;
  error?: string;
}

interface Internal extends AuthState {
  token: string | null;
  expiresAt: number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string; hint?: string }): void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(c: {
            client_id: string;
            scope: string;
            callback: (r: TokenResponse) => void;
            error_callback?: (e: { type?: string; message?: string }) => void;
          }): TokenClient;
          revoke(token: string, done?: () => void): void;
        };
      };
    };
  }
}

function readSavedAccount(): Account | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    return raw ? (JSON.parse(raw) as Account) : null;
  } catch {
    return null;
  }
}

const saved = readSavedAccount();
let state: Internal = { account: saved, needsReconnect: !!saved, busy: false, token: null, expiresAt: 0 };
let snapshot: AuthState = publicState();
const listeners = new Set<() => void>();

function publicState(): AuthState {
  return { account: state.account, needsReconnect: state.needsReconnect, busy: state.busy, error: state.error };
}

function set(patch: Partial<Internal>) {
  state = { ...state, ...patch };
  snapshot = publicState();
  listeners.forEach((l) => l());
}

export const isAuthConfigured = () => !!CLIENT_ID;
export const currentAccount = () => state.account;

interface Handlers {
  onSignIn?: (email: string) => void | Promise<void>;
  onSignOut?: () => void | Promise<void>;
}
let handlers: Handlers = {};
/** The app registers what should happen to stored files when the account changes. */
export function onAuthChange(h: Handlers) {
  handlers = h;
}

let gisLoading: Promise<void> | undefined;
function loadGis(): Promise<void> {
  gisLoading ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisLoading = undefined;
      reject(new Error("Couldn't load Google sign-in. Check your connection or ad blocker."));
    };
    document.head.appendChild(s);
  });
  return gisLoading;
}

let client: TokenClient | undefined;
let pending: { resolve: (t: TokenResponse) => void; reject: (e: Error) => void } | undefined;

async function tokenClient(): Promise<TokenClient> {
  if (!CLIENT_ID) throw new Error('Google sign-in is not set up yet. Add VITE_GOOGLE_CLIENT_ID (see SETUP.md).');
  await loadGis();
  client ??= window.google!.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (r) => pending?.resolve(r),
    error_callback: (e) =>
      pending?.reject(new Error(e.type === 'popup_closed' ? 'The sign-in window was closed.' : e.message || 'Sign-in was blocked. Allow pop-ups for this site and try again.')),
  });
  return client;
}

async function requestToken(prompt: string, hint?: string): Promise<TokenResponse> {
  const c = await tokenClient();
  return new Promise<TokenResponse>((resolve, reject) => {
    pending = { resolve, reject };
    c.requestAccessToken({ prompt, ...(hint ? { hint } : {}) });
  }).finally(() => (pending = undefined));
}

function accept(r: TokenResponse): string {
  if (r.error || !r.access_token) throw new Error(r.error_description || r.error || 'Google did not return an access token.');
  // The Drive scope is optional on the consent screen; without it we can't save to Drive.
  if (r.scope && !r.scope.includes('drive.file')) throw new Error('Drive access was not granted. Sign in again and allow the "Reskin Mockups" files permission.');
  set({ token: r.access_token, expiresAt: Date.now() + (Number(r.expires_in) || 3600) * 1000 });
  return r.access_token;
}

export async function signIn(): Promise<void> {
  set({ busy: true, error: undefined });
  try {
    const token = accept(await requestToken(state.account ? '' : 'select_account', state.account?.email));
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error("Signed in, but Google wouldn't share the account email.");
    const info = (await res.json()) as { email?: string; name?: string; picture?: string };
    if (!info.email) throw new Error("Signed in, but Google wouldn't share the account email.");
    await finishSignIn({ email: info.email, name: info.name, picture: info.picture });
  } catch (e) {
    set({ busy: false, error: e instanceof Error ? e.message : String(e), token: null, expiresAt: 0 });
    throw e;
  }
}

async function finishSignIn(account: Account) {
  try {
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  } catch {
    /* private mode: the session still works, it just isn't remembered */
  }
  await handlers.onSignIn?.(account.email);
  set({ account, needsReconnect: false, busy: false, error: undefined });
}

/** A valid access token, refreshing it if needed. Refreshing may open Google's popup, so call it from a click. */
export async function getToken(): Promise<string> {
  if (state.token && state.expiresAt - 60_000 > Date.now()) return state.token;
  if (!state.account) throw new Error('Sign in with Google first.');
  set({ busy: true, error: undefined });
  try {
    const token = accept(await requestToken('', state.account.email));
    set({ busy: false, needsReconnect: false });
    return token;
  } catch (e) {
    set({ busy: false, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/** Forgets the account here. Files that were kept for the account go back to the 24-hour guest timer. */
export async function signOut(opts: { revoke?: boolean } = {}): Promise<void> {
  const token = state.token;
  if (opts.revoke && token) window.google?.accounts.oauth2.revoke(token);
  try {
    localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    /* ignore */
  }
  set({ account: null, token: null, expiresAt: 0, needsReconnect: false, busy: false, error: undefined });
  await handlers.onSignOut?.();
}

export function useAuth(): AuthState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
  );
}

// Development only: lets tests exercise the signed-in UI and Drive code without a real Google account.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __reskinAuth: unknown }).__reskinAuth = {
    fakeSignIn: async (email = 'test@example.com') => {
      set({ token: 'fake-token', expiresAt: Date.now() + 3_600_000 });
      await finishSignIn({ email, name: 'Test User' });
    },
  };
}
