// ============================================================================
// api.js — the tiny fetch helper (the app's ONLY way to talk to the server)
// ============================================================================
//
// Design: one `request()` function that does the JSON plumbing, and one named
// method per endpoint so components read like prose (`api.listContacts(...)`)
// and never build URLs or headers themselves. No axios/react-query — fetch
// plus ~40 lines covers everything this app needs.

// Errors carry the HTTP status and the server's parsed JSON payload.
// The status matters because the UI branches on it: 409 from createContact
// isn't a failure, it's the duplicate-warning flow (payload.matches holds
// the candidates). Everything else surfaces payload.error as the message.
export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error || `Request failed (HTTP ${status})`);
    this.status = status;
    this.payload = payload;
  }
}

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  // The API always answers JSON, but a proxy failure (server down) can
  // produce an HTML error page — guard the parse so THAT failure mode
  // becomes a readable ApiError too, not a cryptic SyntaxError.
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON body; payload stays null and the status drives the message */
  }

  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

// Drops empty-string/undefined params so the query string only contains
// filters the user actually set (?type=&status= would 400 on the API, which
// validates values against its whitelists).
function queryString(params) {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== ''
  );
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
}

export const api = {
  listContacts: (params = {}) => request(`/api/contacts${queryString(params)}`),

  getContact: (id) => request(`/api/contacts/${id}`),

  // `force` re-submits past the duplicate warning (Phase 3b's escape hatch).
  createContact: (data, { force = false } = {}) =>
    request(`/api/contacts${force ? '?force=true' : ''}`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateContact: (id, data) =>
    request(`/api/contacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  addActivity: (id, data) =>
    request(`/api/contacts/${id}/activities`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  listWorkplaces: () => request('/api/workplaces'),
};
