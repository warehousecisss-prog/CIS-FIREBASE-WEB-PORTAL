import { useEffect, useState } from 'react';
import { onAuthChange, signIn, isConfigured, missingConfigKeys } from '../auth';

/**
 * Wraps the whole app and renders it only once someone is signed in.
 *
 * WHY A GATE RATHER THAN A REDIRECT
 * ---------------------------------
 * Every route in this app needs an identity -- there is no public page -- and
 * the backend rejects an unauthenticated request with a 401 rather than
 * substituting a placeholder operator (the Phase 1 auth decision, AUDIT C5).
 * Rendering the portal before sign-in would therefore paint a full UI whose
 * every request fails, which reads as "the system is broken" rather than "you
 * are not signed in".
 *
 * THREE STATES, ALL EXPLICIT
 * --------------------------
 *   checking      -- the SDK is restoring a previous session. Brief, but it
 *                    MUST be distinguishable from "signed out", or a page
 *                    reload flashes the sign-in screen at someone who is
 *                    already signed in.
 *   unconfigured  -- the build has no Firebase config. Names the missing
 *                    variables instead of failing as a mysterious sign-in
 *                    error.
 *   signed out    -- offer the button.
 */
export default function AuthGate({ children }) {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthChange((u) => {
      setUser(u);
      setChecking(false);
    });
    return unsubscribe;
  }, []);

  const handleSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn();
    } catch (e) {
      // Two of these are routine and should not read as failures.
      if (e && e.code === 'auth/popup-closed-by-user') {
        setError(null);
      } else if (e && e.code === 'auth/popup-blocked') {
        setError('Your browser blocked the sign-in popup. Allow popups for this site and try again.');
      } else {
        setError((e && e.message) || 'Sign-in failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (checking) return <Centered>Checking sign-in…</Centered>;

  if (!isConfigured()) {
    return (
      <Centered>
        <h2 style={{ marginBottom: 12 }}>Not configured</h2>
        <p style={{ maxWidth: 460, lineHeight: 1.5, opacity: 0.85 }}>
          This build has no Firebase configuration, so it cannot sign anyone in.
          Create <code>frontend/.env</code> from <code>frontend/.env.example</code>
          {' '}and rebuild.
        </p>
        <p style={{ marginTop: 12, opacity: 0.7 }}>Missing:</p>
        <ul style={{ opacity: 0.7 }}>
          {missingConfigKeys().map((k) => <li key={k}><code>{k}</code></li>)}
        </ul>
      </Centered>
    );
  }

  if (!user) {
    return (
      <Centered>
        <h2 style={{ marginBottom: 8 }}>CIS Warehouse Portal</h2>
        <p style={{ marginBottom: 20, opacity: 0.8 }}>Sign in with your work Google account.</p>
        <button
          onClick={handleSignIn}
          disabled={busy}
          style={{
            padding: '10px 22px', fontSize: 15, cursor: busy ? 'default' : 'pointer',
            background: '#4dabff', color: '#0b0b0b', border: 'none', borderRadius: 4,
            fontWeight: 600, opacity: busy ? 0.6 : 1
          }}
        >
          {busy ? 'Signing in…' : 'Sign in with Google'}
        </button>
        {error && (
          <p style={{ marginTop: 16, color: '#ff8a80', maxWidth: 460, lineHeight: 1.4 }}>{error}</p>
        )}
      </Centered>
    );
  }

  return children;
}

/**
 * @param {{children: *}} props
 */
function Centered({ children }) {
  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: '#1e1e1e', color: 'white', textAlign: 'center', padding: 24
    }}>
      {children}
    </div>
  );
}
