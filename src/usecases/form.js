// Form filling from data you already have.
//
// One Jev question per value: which field is this value for? The abstention is the product.
// Mis-filling a form is worse than leaving a field blank, because a blank field is visible and
// a wrong value is not. So a value that does not clear the floor is reported unplaced rather
// than written somewhere plausible.

const FIELD_ROLES = new Set(['textbox', 'searchbox', 'password', 'select', 'checkbox', 'radio']);

export async function fill({ resolver, index, values, apply = null, floor = 0.6 }) {
  const fields = index.filter((e) => FIELD_ROLES.has(e.role));
  const placed = [];
  const unplaced = [];

  for (const [label, value] of Object.entries(values)) {
    if (!fields.length) { unplaced.push({ label, value, reason: 'no fields on this page' }); continue; }
    const target = { kind: 'search', query: label };
    const out = await resolver(target, fields, { operator: 'change', target });

    if (out.abstained) { unplaced.push({ label, value, reason: out.reason, confidence: out.confidence ?? null }); continue; }
    if (out.confidence !== null && out.confidence < floor) {
      unplaced.push({ label, value, reason: `confidence ${out.confidence.toFixed(2)} below ${floor}`, confidence: out.confidence });
      continue;
    }
    const field = fields.find((f) => f.fp === out.fp);
    if (!field) { unplaced.push({ label, value, reason: 'resolved to something that is not a field' }); continue; }
    if (apply) apply(field, value);
    placed.push({ label, value, field: field.name, role: field.role, fingerprint: field.fp, confidence: out.confidence });
  }

  return { placed, unplaced, fields: fields.length,
           complete: unplaced.length === 0, needsHuman: unplaced.length > 0 };
}
