// The whole app: fetch the file, colour by industry, render newest first.
// No framework and no build step, so the daily job only ever rewrites data/inventions.json.

const HUES = ['#ffd166', '#7ec4ff', '#9ae6b4', '#f6a5c0', '#c3a6ff', '#ffb27a',
              '#7fded6', '#e8d07a', '#a0b4ff', '#f49ca0', '#8fd3a4', '#d9a6ff', '#7ab8a0'];

const state = { all: [], field: 'all', sort: 'rating' };

const escape = (text) => String(text ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// One stable hue per industry, so the same industry is the same colour on every visit even as the
// list grows and the alphabetical order shifts.
function hueFor(field) {
  let h = 0;
  for (let i = 0; i < field.length; i++) h = (h * 31 + field.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

function when(iso) {
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (Number.isNaN(days)) return '';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// How widely needed, as a word rather than a bare number: a reader should not have to learn what
// 72 out of 100 means.
function band(rating) {
  if (typeof rating !== 'number') return { label: 'not scored yet', tone: 'none' };
  if (rating >= 85) return { label: 'almost everyone needs this', tone: 'hot' };
  if (rating >= 70) return { label: 'very widely needed', tone: 'high' };
  if (rating >= 50) return { label: 'widely needed', tone: 'mid' };
  if (rating >= 30) return { label: 'needed by some', tone: 'low' };
  return { label: 'niche', tone: 'niche' };
}

function row(term, value) {
  if (!value || String(value).trim().length < 2) return '';
  return `<dt>${escape(term)}</dt><dd>${escape(value)}</dd>`;
}

function card(idea) {
  const hue = hueFor(idea.sector || 'other');
  const hand = idea.checked === 'human';
  return `<article class="card" style="--hue:${hue}" id="idea-${idea.id}">
    <div class="card-top">
      <span class="num">#${idea.id}</span>
      <h2 class="name">${escape(idea.name)}</h2>
      <div class="badges">
        <span class="badge field">${escape(idea.sector || 'other')}</span>
        <span class="badge ${hand ? 'hand' : 'machine'}">${hand ? 'checked by hand' : 'checked by machine'}</span>
        <span class="badge">${escape(when(idea.published))}</span>
      </div>
    </div>
    <div class="need tone-${band(idea.rating).tone}">
      <div class="meter" role="img" aria-label="how widely needed: ${escape(String(idea.rating ?? 'unscored'))} out of 100">
        <span style="width:${Math.max(3, Number(idea.rating) || 0)}%"></span>
      </div>
      <span class="need-label"><b>${escape(String(idea.rating ?? '—'))}</b>/100 · ${escape(band(idea.rating).label)}</span>
    </div>
    <p class="plain">${escape(idea.plain || idea.one_line)}</p>
    ${idea.demand ? `<p class="helps demand">${escape(idea.demand)}</p>` : ''}
    ${idea.who_it_helps ? `<p class="helps">Helps <b>${escape(idea.who_it_helps)}</b></p>` : ''}
    <details>
      <summary>Show the detail</summary>
      <dl>
        ${row('In one line', idea.one_line)}
        ${row('The old tool', idea.tool)}
        ${row('The costly job', idea.task)}
        ${row('How it works', idea.how_it_works)}
        ${row('Works on its own', idea.works_alone)}
        ${row('Replaces', idea.instead_of)}
        ${row('Closest thing today', idea.closest_today)}
        ${row('Why it differs', idea.different_because)}
        ${row('Better at', idea.better_at)}
        ${row('Who would pay', idea.who_pays)}
        ${row('Price', idea.price)}
        ${row('First week', idea.first_week)}
        ${row('Wrong if', idea.wrong_if)}
      </dl>
    </details>
  </article>`;
}

function render() {
  const list = document.getElementById('list');
  let shown = state.field === 'all' ? state.all : state.all.filter((i) => i.sector === state.field);
  shown = [...shown].sort(state.sort === 'newest'
    ? (a, b) => b.id - a.id
    : (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || b.id - a.id);
  list.innerHTML = shown.length ? shown.map(card).join('')
    : '<p class="empty">Nothing in that industry yet.</p>';
  for (const button of document.querySelectorAll('.sort-btn')) {
    button.setAttribute('aria-pressed', String(button.dataset.sort === state.sort));
  }
  for (const chip of document.querySelectorAll('.chip')) {
    const on = chip.dataset.field === state.field;
    chip.setAttribute('aria-pressed', String(on));
    chip.style.background = on ? hueFor(chip.dataset.field) : '';
    if (chip.dataset.field === 'all' && on) chip.style.background = 'var(--accent)';
  }
}

function chips(all) {
  const counts = new Map();
  for (const i of all) counts.set(i.sector, (counts.get(i.sector) || 0) + 1);
  const fields = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const nav = document.getElementById('filters');
  nav.innerHTML = [['all', all.length], ...fields].map(([field, n]) =>
    `<button class="chip" data-field="${escape(field)}" aria-pressed="false">${escape(field)}<span class="n">${n}</span></button>`).join('');
  nav.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    state.field = chip.dataset.field;
    render();
  });
}

(async function start() {
  try {
    // Cache-busted: the file is rewritten daily and a stale copy would hide the new ideas.
    const res = await fetch(`data/inventions.json?v=${Date.now()}`);
    const data = await res.json();
    state.all = data.inventions || [];
    document.getElementById('count').textContent = state.all.length;
    document.getElementById('fields').textContent = new Set(state.all.map((i) => i.sector)).size;
    document.getElementById('updated').textContent = when(data.updated);
    const rated = state.all.filter((i) => typeof i.rating === 'number');
    document.getElementById('avg').textContent = rated.length
      ? Math.round(rated.reduce((s, i) => s + i.rating, 0) / rated.length) : '—';
    chips(state.all);
    document.getElementById('sorts').addEventListener('click', (event) => {
      const button = event.target.closest('.sort-btn');
      if (!button) return;
      state.sort = button.dataset.sort;
      render();
    });
    render();
  } catch (error) {
    document.getElementById('list').innerHTML =
      `<p class="empty">Could not load the ideas. ${escape(error.message)}</p>`;
  }
})();
