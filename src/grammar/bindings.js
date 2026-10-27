// The L0 store: motions that have already been resolved once, kept as fingerprints so the
// next press of the same keys costs nothing and touches no network. This is the tier the
// whole product anneals towards, so the file it exports is deliberately human-readable —
// a keymap a person can read, edit, diff and hand to someone else.

/** A stable key for "this motion, on this site". */
export function motionKey(target) {
  switch (target.kind) {
    case 'search': return `search:${target.query.toLowerCase()}`;
    case 'textobject': return `object:${target.inner ? 'i' : 'a'}:${target.id}`;
    case 'edge': return `edge:${target.id}`;
    case 'hint': return 'hint';
    default: return `${target.kind}`;
  }
}

/** In-memory store; the extension swaps in a chrome.storage-backed one with the same shape. */
export function memoryStore(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    read: (site) => data.get(site) || {},
    write: (site, value) => { data.set(site, value); },
    sites: () => [...data.keys()],
  };
}

export function createBindings(store) {
  /** The fingerprint previously confirmed for this motion, or null. */
  function lookup(site, target) {
    const entry = store.read(site)[motionKey(target)];
    return entry ? entry.fp : null;
  }

  /**
   * What the binding was pointing at: role, name and context.
   *
   * A fingerprint alone cannot be repaired. When a site is redesigned the element gets a NEW
   * fingerprint, so the old one is simply absent from the index and there is nothing left to
   * describe - unless the description was stored with it.
   */
  function describe(site, target) {
    const entry = store.read(site)[motionKey(target)];
    return entry && entry.descriptor ? { ...entry.descriptor, fp: entry.fp } : null;
  }

  /**
   * Promote a resolution to L0. Called only for resolutions the user actually accepted.
   *
   * `what` may be a fingerprint string or a whole index entry. Passing the entry is preferred and is
   * what callers should do: the descriptor is then derived automatically, and a binding stored without
   * one cannot be repaired after a redesign. Making it derivable removes the chance to forget it.
   */
  function remember(site, target, what, { confidence = null, source = 'user', descriptor = null } = {}) {
    const fromEntry = what && typeof what === 'object';
    const fp = fromEntry ? what.fp : what;
    const derived = fromEntry
      ? { role: what.role, name: what.name, ctx: what.ctx, anc: what.anc }
      : descriptor;
    const site_map = { ...store.read(site) };
    const key = motionKey(target);
    const previous = site_map[key];
    site_map[key] = {
      fp,
      uses: (previous && previous.fp === fp ? previous.uses : 0) + 1,
      confidence,
      source,
      // Kept so the binding can be repaired after a redesign changes the fingerprint.
      descriptor: derived || (previous && previous.descriptor) || null,
    };
    store.write(site, site_map);
    return site_map[key];
  }

  function forget(site, target) {
    const site_map = { ...store.read(site) };
    delete site_map[motionKey(target)];
    store.write(site, site_map);
  }

  /** The shareable keymap. One line per binding, readable without this codebase. */
  function toKeymap() {
    const lines = [];
    for (const site of store.sites().sort()) {
      const site_map = store.read(site);
      const keys = Object.keys(site_map).sort();
      if (!keys.length) continue;
      lines.push(`site ${site}`);
      for (const key of keys) {
        const entry = site_map[key];
        const confidence = entry.confidence === null ? '-' : entry.confidence.toFixed(2);
        lines.push(`  ${key} -> ${entry.fp}  uses=${entry.uses} conf=${confidence} via=${entry.source}`);
      }
    }
    return lines.join('\n');
  }

  return { lookup, describe, remember, forget, toKeymap };
}
