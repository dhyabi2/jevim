// The live demo: start one run, then follow it through server-sent events.
const $ = (id) => document.getElementById(id);
const form = $('form');
const go = $('go');

// The API examples point at wherever this page is served from.
for (const pre of document.querySelectorAll('pre code')) {
  pre.textContent = pre.textContent.replaceAll('https://agent.172.86.85.83.sslip.io', location.origin);
}

async function showQuota() {
  try {
    const q = await (await fetch('/api/v1/quota')).json();
    if (q.unlimited) return;
    $('quota').textContent = q.free_runs_left > 0
      ? `${q.free_runs_left} free run${q.free_runs_left === 1 ? '' : 's'} left.` : 'You have used your free runs.';
    if (q.free_runs_left <= 0) go.disabled = true;
  } catch { /* the page still works without it */ }
}
showQuota();

for (const b of document.querySelectorAll('.examples button')) {
  b.addEventListener('click', () => { $('website').value = b.dataset.site; $('task').value = b.dataset.task; $('task').focus(); });
}

function setStatus(status, position) {
  const pill = $('status');
  pill.className = `pill ${status}`;
  pill.textContent = status === 'queued' ? (position > 1 ? `In line (#${position})` : 'Starting') :
    { running: 'Working', done: 'Done', stopped: 'Stopped', failed: 'Failed' }[status] || status;
}

function addStep(step) {
  const li = document.createElement('li');
  li.textContent = step.action;
  const out = document.createElement('span');
  out.className = 'out';
  out.textContent = step.outcome;
  li.append(out);
  $('steps').append(li);
  li.scrollIntoView({ block: 'nearest' });
}

let clock;
function startClock() {
  const t0 = Date.now();
  clearInterval(clock);
  clock = setInterval(() => { $('clock').textContent = `${Math.round((Date.now() - t0) / 1000)} s`; }, 1000);
}

function follow(id) {
  $('live').hidden = false;
  $('live').scrollIntoView({ behavior: 'smooth' });
  $('steps').replaceChildren();
  $('result').hidden = true;
  $('frame').hidden = true;
  $('waiting').hidden = false;
  startClock();
  const events = new EventSource(`/api/v1/runs/${id}/events`);
  events.addEventListener('status', (e) => {
    const d = JSON.parse(e.data);
    setStatus(d.status, d.position);
    if (d.status === 'running' && $('frame').hidden) $('waiting').textContent = 'Opening the website…';
  });
  events.addEventListener('step', (e) => { setStatus('running'); addStep(JSON.parse(e.data)); });
  events.addEventListener('frame', (e) => {
    $('frame').src = `data:image/jpeg;base64,${JSON.parse(e.data).image}`;
    $('frame').hidden = false;
    $('waiting').hidden = true;
  });
  events.addEventListener('done', (e) => {
    const run = JSON.parse(e.data);
    events.close();
    clearInterval(clock);
    setStatus(run.status);
    $('result').hidden = false;
    $('answer').textContent = run.error || run.answer || 'The agent finished without an answer.';
    const tokens = run.tokens ? (run.tokens.prompt || 0) + (run.tokens.completion || 0) : 0;
    const c = run.cost;
    const cost = c && typeof c.usd === 'number'
      ? `cost $${c.usd < 0.01 ? c.usd.toFixed(4) : c.usd.toFixed(3)}${typeof c.xno === 'number' ? ` = ${c.xno.toFixed(4)} XNO` : ''}` : null;
    $('meta').textContent = [run.seconds && `${run.seconds} s`, run.steps && `${run.steps.length} actions`,
                             tokens && `${tokens.toLocaleString()} AI tokens`, cost].filter(Boolean).join(' · ');
    if (c && c.rate) {
      $('meta').title = `1 XNO = $${c.rate.usd_per_xno} (${c.rate.source}, ${new Date(c.rate.at).toLocaleString()})`;
    }
    $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    showQuota();
  });
  events.onerror = () => { /* EventSource reconnects by itself; the server replays what was missed */ };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  $('error').hidden = true;
  go.disabled = true;
  try {
    const res = await fetch('/api/v1/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ website: $('website').value.trim(), task: $('task').value.trim() }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Something went wrong.');
    follow(body.id);
  } catch (error) {
    $('error').textContent = error.message;
    $('error').hidden = false;
    go.disabled = false;
  }
});
