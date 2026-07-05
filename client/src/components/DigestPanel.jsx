// ============================================================================
// DigestPanel — "email me today's tasks" (Phase 9), lives atop the Agenda
// ============================================================================
//
// Two actions:
//   * Preview — GET the built digest and render it in an isolated iframe, so
//     the feature is demoable without opening an inbox (and needs no Google).
//   * Send    — POST to email it to the rep's own address. On the not-
//     connected 409 it degrades to a "Connect Google" link, same as the
//     calendar button.
//
// The preview HTML is server-generated (our own digest.js) and rendered via
// <iframe srcDoc> — the iframe sandboxes it from the app's styles so the
// email renders as it actually would, and keeps its inline CSS out of the app.
import { useState } from 'react';
import { api, ApiError } from '../api.js';

export default function DigestPanel() {
  const [preview, setPreview] = useState(null); // { subject, html, counts } | null
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(null); // 'preview' | 'send' | null
  const [sent, setSent] = useState(null); // { to } after a successful send
  const [notConnected, setNotConnected] = useState(false);
  const [error, setError] = useState(null);

  async function loadPreview() {
    setBusy('preview');
    setError(null);
    try {
      const p = await api.getDigestPreview();
      setPreview(p);
      setShowPreview(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    setBusy('send');
    setError(null);
    setNotConnected(false);
    try {
      const res = await api.sendDigest();
      setSent({ to: res.to });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.payload?.code === 'google_not_connected') {
        setNotConnected(true);
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card digest-panel">
      <div className="digest-head">
        <div>
          <strong>Daily digest</strong>
          <span className="muted"> — your overdue visits &amp; pending orders, by email</span>
        </div>
        <div className="digest-actions">
          <button className="secondary" disabled={busy !== null} onClick={loadPreview}>
            {busy === 'preview' ? 'Loading…' : showPreview ? 'Refresh preview' : 'Preview'}
          </button>
          <button disabled={busy !== null} onClick={send}>
            {busy === 'send' ? 'Sending…' : '📧 Send me today’s tasks'}
          </button>
        </div>
      </div>

      {sent && (
        <p className="digest-sent">✓ Sent to {sent.to} — check your inbox.</p>
      )}
      {notConnected && (
        <p className="muted">
          <a href="/auth/google">Connect Google</a> to email yourself the digest.
          (You can still preview it below.)
        </p>
      )}
      {error && <p className="error-banner">{error}</p>}

      {showPreview && preview && (
        <div className="digest-preview">
          <div className="muted digest-subject">Subject: {preview.subject}</div>
          {/* Isolated render of the actual email HTML. sandbox with no
              allow-* tokens: the email can't run scripts or navigate. */}
          <iframe
            title="Digest preview"
            className="digest-iframe"
            sandbox=""
            srcDoc={preview.html}
          />
        </div>
      )}
    </div>
  );
}
