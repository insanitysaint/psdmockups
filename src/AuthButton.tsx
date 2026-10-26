import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { isAuthConfigured, signIn, signOut, useAuth } from './lib/auth';

function SetupDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Set up Google sign-in" onClose={onClose}>
      <p>
        Sign-in needs a Google OAuth <strong>Client ID</strong> that belongs to you. It takes about five minutes, and the app keeps working as a guest until
        then.
      </p>
      <ol className="steps">
        <li>
          In the <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Google Cloud console</a>, create a
          project and enable the <strong>Google Drive API</strong>.
        </li>
        <li>
          Configure the OAuth consent screen (External). The only Drive permission this app asks for is <code>drive.file</code>, which lets it see just the
          files it creates, so no Google review is needed.
        </li>
        <li>
          Create an <strong>OAuth client ID</strong> of type <em>Web application</em>. Under <em>Authorized JavaScript origins</em> add{' '}
          <code>https://reskin.in</code> and <code>http://localhost:5173</code>.
        </li>
        <li>
          Put the client ID in a file named <code>.env.local</code> next to <code>package.json</code>:
          <pre>VITE_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com</pre>
          then restart the dev server (or rebuild for production).
        </li>
      </ol>
      <p className="hint">The same steps are in SETUP.md in the project folder.</p>
    </Modal>
  );
}

export function AuthButton() {
  const auth = useAuth();
  const [setup, setSetup] = useState(false);
  const [menu, setMenu] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  if (auth.account) {
    const initial = (auth.account.name || auth.account.email)[0]?.toUpperCase();
    return (
      <div className="account" ref={root}>
        <button className="btn account-btn" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} title={auth.account.email}>
          {auth.account.picture ? <img src={auth.account.picture} alt="" referrerPolicy="no-referrer" /> : <span className="avatar">{initial}</span>}
          <span className="account-email">{auth.account.email}</span>
        </button>
        {menu && (
          <div className="menu" role="menu">
            <div className="menu-info">
              Signed in{auth.needsReconnect ? ' · Drive reconnects when you use it' : ''}
              <br />
              Your files are kept until you remove them.
            </div>
            <button role="menuitem" onClick={() => void signOut().then(() => setMenu(false))}>
              Sign out
            </button>
            <button role="menuitem" onClick={() => void signOut({ revoke: true }).then(() => setMenu(false))}>
              Sign out and revoke Drive access
            </button>
            <div className="menu-info small">Signing out puts your files back on the 24-hour guest timer.</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        className="btn"
        disabled={auth.busy}
        onClick={() => {
          if (!isAuthConfigured()) return setSetup(true);
          void signIn().catch(() => undefined); // the error is shown below via auth.error
        }}
      >
        {auth.busy ? 'Signing in…' : 'Sign in with Google'}
      </button>
      {auth.error && (
        <span className="auth-error" role="alert" title={auth.error}>
          {auth.error}
        </span>
      )}
      {setup && <SetupDialog onClose={() => setSetup(false)} />}
    </>
  );
}
