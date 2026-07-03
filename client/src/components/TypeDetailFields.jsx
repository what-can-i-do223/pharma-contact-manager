// The type-specific form fields, driven by one spec object — the client-side
// mirror of the server's DETAIL_SPEC. Used in two places:
//   * NewContact — the type picker swaps which of these render,
//   * ContactDetail — the edit panel renders them for the contact's type.
// One component means the two forms can't drift apart.

// What to render per contact type. `kind: 'checkbox'` maps to a boolean
// field; everything else is a text input.
const FIELD_SPEC = {
  hcp: [
    { name: 'specialty', label: 'Specialty *', placeholder: 'e.g. Cardiologist' },
    { name: 'role', label: 'Role', placeholder: 'e.g. Senior Consultant' },
  ],
  pharmacist: [
    { name: 'is_owner', label: 'Owns the pharmacy', kind: 'checkbox' },
  ],
  procurement: [
    { name: 'purchasing_role', label: 'Purchasing role *', placeholder: 'e.g. Purchase Officer' },
  ],
};

// Controlled inputs: `values` holds the current details object, `onChange`
// receives the whole updated object (parent owns the state — this component
// is just fields).
export default function TypeDetailFields({ type, values, onChange }) {
  const fields = FIELD_SPEC[type] ?? [];

  const set = (name, value) => onChange({ ...values, [name]: value });

  return (
    <>
      {fields.map((f) =>
        f.kind === 'checkbox' ? (
          <label key={f.name} className="field checkbox">
            <input
              type="checkbox"
              checked={!!values[f.name]}
              onChange={(e) => set(f.name, e.target.checked)}
            />
            {f.label}
          </label>
        ) : (
          <label key={f.name} className="field">
            {f.label}
            <input
              type="text"
              value={values[f.name] ?? ''}
              placeholder={f.placeholder}
              onChange={(e) => set(f.name, e.target.value)}
            />
          </label>
        )
      )}
    </>
  );
}
