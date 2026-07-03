// ============================================================================
// NewContact — create form: type picker swaps fields; duplicate-warning flow
// ============================================================================
//
// The duplicate flow (Phase 3b, client side): submit normally → if the API
// answers 409, render its candidate matches INSTEAD of treating it as an
// error; the user either navigates to an existing contact (it was a dupe)
// or clicks "Create anyway", which re-submits the same payload with
// ?force=true. The 409 payload is data, not failure.
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { TypeBadge } from '../components/Badges.jsx';
import TypeDetailFields from '../components/TypeDetailFields.jsx';

const TYPES = [
  { value: 'hcp', label: 'Doctor (HCP)' },
  { value: 'pharmacist', label: 'Pharmacist' },
  { value: 'procurement', label: 'Procurement officer' },
];

// Which workplace kinds make sense per contact type — filters the dropdown
// so a pharmacist isn't offered hospitals. Purely a UX nicety: the API
// doesn't (and needn't) enforce this pairing.
const WORKPLACE_KINDS_FOR_TYPE = {
  hcp: ['hospital', 'clinic'],
  pharmacist: ['pharmacy'],
  procurement: ['hospital', 'distributor'],
};

const EMPTY_FORM = {
  contact_type: 'hcp',
  full_name: '',
  city: '',
  phone: '',
  email: '',
  tier: 'C',
  workplace_id: '',
  details: {},
};

export default function NewContact() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [workplaces, setWorkplaces] = useState([]);
  const [dupMatches, setDupMatches] = useState(null); // non-null → showing the 409 flow
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  // Workplaces load once — a small, static-ish list used to populate the
  // dropdown. Failure here shouldn't block creating a contact (workplace is
  // optional), so it degrades to an empty dropdown plus the page-level error.
  useEffect(() => {
    api.listWorkplaces().then(setWorkplaces).catch((err) => setError(err.message));
  }, []);

  // Switching type resets details (an HCP's specialty makes no sense on a
  // pharmacist) and the workplace choice (the kind filter changes).
  function switchType(contact_type) {
    set({ contact_type, details: {}, workplace_id: '' });
  }

  const workplaceOptions = workplaces.filter((w) =>
    WORKPLACE_KINDS_FOR_TYPE[form.contact_type].includes(w.kind)
  );

  async function submit({ force = false } = {}) {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        contact_type: form.contact_type,
        full_name: form.full_name,
        city: form.city,
        tier: form.tier,
        details: form.details,
        // Optional fields: send only when filled — the API treats absent
        // and null differently from empty strings (which it rejects).
        ...(form.phone.trim() ? { phone: form.phone } : {}),
        ...(form.email.trim() ? { email: form.email } : {}),
        ...(form.workplace_id ? { workplace_id: form.workplace_id } : {}),
      };
      const created = await api.createContact(payload, { force });
      window.location.hash = `#/contacts/${created.id}`; // navigate to the new contact
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Not an error: the duplicate warning. Render the candidates.
        setDupMatches(err.payload.matches);
      } else {
        setDupMatches(null);
        setError(err.message);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="narrow">
      <h1>New contact</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {/* Type picker — radios, so all three options stay visible and
            switching (which swaps the fields below) feels immediate. */}
        <div className="type-picker">
          {TYPES.map((t) => (
            <label key={t.value} className={form.contact_type === t.value ? 'picked' : ''}>
              <input
                type="radio"
                name="contact_type"
                value={t.value}
                checked={form.contact_type === t.value}
                onChange={() => switchType(t.value)}
              />
              {t.label}
            </label>
          ))}
        </div>

        <label className="field">
          Full name *
          <input
            type="text"
            required
            value={form.full_name}
            placeholder={form.contact_type === 'hcp' ? 'Dr. …' : ''}
            onChange={(e) => set({ full_name: e.target.value })}
          />
        </label>

        <label className="field">
          City *
          <input
            type="text"
            required
            value={form.city}
            onChange={(e) => set({ city: e.target.value })}
          />
        </label>

        <div className="field-row">
          <label className="field">
            Phone
            <input type="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
          </label>
          <label className="field">
            Email
            <input type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} />
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            Tier
            <select value={form.tier} onChange={(e) => set({ tier: e.target.value })}>
              <option value="A">A — visit every 14 days</option>
              <option value="B">B — visit every 30 days</option>
              <option value="C">C — visit every 90 days</option>
            </select>
          </label>
          <label className="field">
            Workplace
            <select
              value={form.workplace_id}
              onChange={(e) => set({ workplace_id: e.target.value })}
            >
              <option value="">— none —</option>
              {workplaceOptions.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.city})
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* The fields this block renders depend on the type picked above. */}
        <TypeDetailFields
          type={form.contact_type}
          values={form.details}
          onChange={(details) => set({ details })}
        />

        {error && <p className="error-banner">{error}</p>}

        {/* The duplicate-warning panel replaces the plain submit button once
            a 409 arrives: the user resolves it by opening a match or forcing. */}
        {dupMatches ? (
          <div className="dup-warning">
            <p>
              <strong>Possible duplicate.</strong> These existing contacts have
              very similar names:
            </p>
            <ul>
              {dupMatches.map((m) => (
                <li key={m.id}>
                  <a href={`#/contacts/${m.id}`}>{m.full_name}</a>{' '}
                  <TypeBadge type={m.contact_type} /> {m.city}
                  <span className="muted"> — {Math.round(m.similarity * 100)}% similar</span>
                </li>
              ))}
            </ul>
            <div className="dup-actions">
              <button type="button" disabled={saving} onClick={() => submit({ force: true })}>
                {saving ? 'Creating…' : 'Create anyway'}
              </button>
              <button type="button" className="secondary" onClick={() => setDupMatches(null)}>
                Back to editing
              </button>
            </div>
          </div>
        ) : (
          <button type="submit" disabled={saving}>
            {saving ? 'Creating…' : 'Create contact'}
          </button>
        )}
      </form>
    </section>
  );
}
