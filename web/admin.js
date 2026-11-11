// Coordinator dashboard.
const A = {
  key: localStorage.getItem('adminKey') || '',
  eid: null, b: null, msgs: [], page: 'overview',
  drawer: null, drawerTab: 'messages', drawerPid: null,
  taskFilter: 'all', phonePid: null, mailPid: null,
};
const root = document.getElementById('root');

async function api(method, path, body) {
  try {
    return await request(method, path, body, { 'x-admin-key': A.key });
  } catch (e) {
    if (e.status === 401) { localStorage.removeItem('adminKey'); A.key = ''; renderLogin('That admin key was not accepted.'); }
    throw e;
  }
}
const act = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, true); throw e; } };

/* ---------------------------------------------------------------- derived */
const tz = () => A.b.event.timezone;
const nowIso = () => A.b.now;
const P = pid => A.b.people[pid] || { id: pid, name: '(removed)', phoneDisplay: '' };
const firstOf = p => p.firstName || (p.name || '').replace(/"[^"]*"\s*/, '').split(' ')[0];
const roleName = k => A.b.event.roles.find(r => r.key === k)?.name || k;

function taskStatus(t) {
  const ss = Object.values(t.assignees).map(a => a.status);
  if (!ss.length) return t.kind === 'coordinator' ? 'todo' : 'unassigned';
  if (ss.every(s => s === 'scheduled')) return 'scheduled';
  if (ss.every(s => s === 'done')) return 'done';
  for (const k of ['help', 'call_needed', 'remind', 'ready', 'reminded', 'sent', 'called', 'todo']) if (ss.includes(k)) return k;
  return ss[0];
}
const started = t => nowIso() >= t.sendAt;
const overdue = t => !['done', 'scheduled'].includes(taskStatus(t)) && nowIso() > t.dueAt;
const ATTN = ['ready', 'remind', 'help', 'call_needed', 'todo'];
function needsAttention(t) {
  const s = taskStatus(t);
  if (s === 'unassigned') return true; // a role nobody holds is a gap, even before it is due
  return started(t) && (Object.values(t.assignees).some(a => ATTN.includes(a.status)) || overdue(t));
}
/** [{t, pid, a}] for every assignee in one of `statuses`. */
const whoIs = (...statuses) => A.b.tasks.flatMap(t => Object.entries(t.assignees).filter(([, a]) => statuses.includes(a.status)).map(([pid, a]) => ({ t, pid, a })));
const bcMissing = bc => bc.to.filter(pid => !bc.acks[pid]);
const ackHours = () => A.b.event.policy.broadcastAckHours;
const smsOn = () => !!A.b.event.policy.sms;
const noEmail = p => !p.email || (p.channels?.length && !p.channels.includes('email'));
const unreachable = p => (smsOn() ? p.mobile === false || !p.phone || p.smsOptIn === false : true) && noEmail(p);
const hoursSince = iso => (Date.parse(nowIso()) - Date.parse(iso)) / 36e5;

/* ---------------------------------------------------------------- routing */
window.addEventListener('hashchange', () => { A.drawer = null; route(); });
async function route() {
  if (!A.key) return renderLogin();
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'e' && parts[1]) {
    A.page = parts[2] || 'overview';
    if (A.eid !== parts[1] || !A.b) { A.eid = parts[1]; await load(); } else render();
  } else {
    A.eid = null; A.b = null;
    renderHome();
  }
}
async function load() {
  try {
    const [b, msgs] = await Promise.all([api('GET', `/admin/events/${A.eid}`), api('GET', `/admin/events/${A.eid}/messages`)]);
    A.b = b;
    // newest first; messages written in the same (simulated) minute keep their real order
    A.msgs = msgs.sort((x, y) => (x.at === y.at ? ((y.realAt || '') > (x.realAt || '') ? 1 : -1) : (y.at > x.at ? 1 : -1)));
    render();
  } catch (e) { root.innerHTML = `<div class="login card"><h3>Could not load the event</h3><p class="muted">${esc(e.message)}</p><a class="btn" href="#/">Back to events</a></div>`; }
}

/* ---------------------------------------------------------------- login & home */
function renderLogin(err) {
  root.innerHTML = `<div class="login card">
    <h2 style="margin-bottom:6px">Activity Manager</h2>
    <p class="muted">Enter the coordinator key to open the dashboard.</p>
    ${err ? `<p style="color:var(--red)">${esc(err)}</p>` : ''}
    <form id="loginForm"><input id="key" type="password" placeholder="Admin key" autofocus>
    <button class="btn primary" style="margin-top:10px;width:100%;justify-content:center">Open dashboard</button></form>
    ${CFG.devMode ? '<p class="small" style="margin-top:12px">Local dev key: <b>local-admin</b></p>' : ''}</div>`;
  document.getElementById('loginForm').onsubmit = e => {
    e.preventDefault();
    A.key = document.getElementById('key').value.trim();
    localStorage.setItem('adminKey', A.key);
    route();
  };
}

async function renderHome() {
  const [events, pbs] = await Promise.all([api('GET', '/admin/events'), api('GET', '/admin/playbooks')]);
  const latest = Object.values(pbs.reduce((m, p) => ((!m[p.id] || m[p.id].version < p.version) ? { ...m, [p.id]: p } : m), {}));
  root.innerHTML = `<div style="max-width:1000px;margin:30px auto;padding:0 20px">
    <div class="page-h"><h2>Events</h2><span class="muted">Every event is created from a playbook - a reusable plan of who does what, when.</span>
      <button class="btn sm" style="margin-left:auto" id="logout">Sign out</button></div>
    <div class="grid" style="margin:16px 0 26px">
      ${events.sort((a, b) => (a.date < b.date ? 1 : -1)).map(e => `<a class="card" style="text-decoration:none;color:inherit;display:flex;gap:14px;align-items:center" href="#/e/${e.id}/overview">
        <div class="grow"><b style="font-size:16px">${esc(e.name)}</b><div class="small">${fmt.ymd(e.date)} - playbook ${esc(e.playbookId)}</div></div>
        <span class="pill ${e.status === 'active' ? 's-done' : 's-scheduled'}">${esc(e.status)}</span></a>`).join('') || '<div class="card muted">No events yet.</div>'}
    </div>
    <div class="grid cols-2">
      <div class="card"><h3>Create an event from a playbook</h3>
        <form id="newEvent" class="grid" style="gap:10px">
          <div class="field"><label>Playbook</label><select name="playbookId">${latest.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (v${p.version})</option>`).join('')}</select></div>
          <div class="field"><label>Event day</label><input type="date" name="date" required></div>
          <div class="field"><label>Name (optional)</label><input name="name" placeholder="Defaults to the playbook name + year"></div>
          <div class="field"><label>Expected guests</label><input type="number" name="guests" placeholder="130"></div>
          <button class="btn primary">Create event</button>
          <div class="small">All tasks are dated relative to the event day. Next, assign people to roles on the Team page.</div>
        </form></div>
      <div class="card"><h3>Playbooks</h3>
        ${latest.map(p => `<div class="row" style="display:block"><b>${esc(p.name)}</b> <span class="small">v${p.version} - ${p.tasks.length} tasks, ${p.roles.length} roles, ${p.shopping?.length || 0} shopping items</span>
          <div class="small">${esc(p.description || '')}</div>
          <details style="margin-top:6px"><summary class="small">Show the task timeline</summary>
          <table style="margin-top:6px">${p.tasks.map(t => `<tr><td class="mono">T${t.send >= 0 ? '+' : ''}${t.send}d</td><td>${esc(t.title)}</td><td class="small">${t.roles.map(r => esc(p.roles.find(x => x.key === r)?.name || r)).join(', ')}</td></tr>`).join('')}</table></details></div>`).join('')}
      </div>
    </div></div>`;
  document.getElementById('logout').onclick = () => { localStorage.removeItem('adminKey'); A.key = ''; renderLogin(); };
  document.getElementById('newEvent').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!f.name) delete f.name;
    if (!f.guests) delete f.guests;
    const ev = await act(() => api('POST', '/admin/events', f), 'Event created');
    location.hash = `#/e/${ev.id}/team`;
  };
}

/* ---------------------------------------------------------------- shell */
const PAGES = [
  ['overview', 'Overview'], ['tasks', 'Tasks & timeline'], ['contacts', 'Contacts'], ['team', 'Team & roles'], ['shifts', 'Volunteer shifts'],
  ['broadcast', 'Announcements'], ['shopping', 'Shopping list'], ['results', 'Results & report'], ['messages', 'Message log'],
];
function render() {
  const b = A.b;
  const attention = b.tasks.filter(needsAttention).length + b.broadcasts.filter(x => hoursSince(x.sentAt) >= ackHours() && bcMissing(x).length).length;
  const days = Math.ceil((Date.parse(b.event.date + 'T12:00:00Z') - Date.parse(nowIso())) / 864e5);
  const pages = b.devMode ? [...PAGES, ['dev', 'Phone & email simulator']] : PAGES;
  root.innerHTML = `<div class="app">
    <aside><div class="brand">Activity Manager</div><div class="sub">${esc(b.event.organization)}</div>
      <nav>${pages.map(([k, l]) => `<a href="#/e/${A.eid}/${k}" class="${A.page === k ? 'on' : ''}">${l}${k === 'overview' && attention ? `<span class="badge">${attention}</span>` : ''}</a>`).join('')}
      <div class="sep"></div><a href="#/">All events & playbooks</a></nav></aside>
    <main>
      <div class="topbar">
        <div><div class="title">${esc(b.event.name)}</div>
          <div class="small">${fmt.ymd(b.event.date)} - ${esc(b.event.venue)} - ${days > 0 ? `${days} days to go` : days === 0 ? 'Today!' : `${-days} days ago`}</div></div>
        ${clockBox()}
      </div>
      <div id="page"></div>
    </main></div>
    <div id="drawerRoot"></div>`;
  bindClock();
  const page = { overview: pOverview, tasks: pTasks, contacts: pContacts, team: pTeam, shifts: pShifts, broadcast: pBroadcast, shopping: pShopping, results: pResults, messages: pMessages, dev: pDev }[A.page] || pOverview;
  page(document.getElementById('page'));
  if (A.drawer) renderDrawer();
}

/* ---------------------------------------------------------------- dev clock */
function clockBox() {
  const sim = A.b.devMode && A.clockSimulated;
  if (!A.b.devMode) return `<div class="clock"><span class="small">Now</span><b>${fmt.dt(nowIso(), tz())}</b></div>`;
  return `<div class="clock ${sim ? 'sim' : ''}" title="Dev mode: move time forward to see what the dashboard asks you to do">
    <span class="small">${sim ? 'Simulated time' : 'Real time'}</span><b>${fmt.dt(nowIso(), tz())}</b>
    <button class="btn sm" data-clock="1">+1 day</button><button class="btn sm" data-clock="7">+1 week</button>
    <button class="btn sm" data-clock="next" title="Jump to when the next task is ready to send">Next task</button></div>`;
}
function bindClock() {
  root.querySelectorAll('[data-clock]').forEach(btn => btn.onclick = () => moveClock(btn.dataset.clock));
}
async function moveClock(how) {
  let target = null;
  if (how === 'real') target = null;
  else if (how === 'next') {
    const next = A.b.tasks.filter(t => t.sendAt > nowIso()).map(t => t.sendAt).sort()[0];
    if (!next) return toast('Nothing else is scheduled');
    target = new Date(Date.parse(next) + 60e3).toISOString();
  } else if (how.startsWith('iso:')) target = how.slice(4);
  else target = new Date(Date.parse(nowIso()) + Number(how) * 864e5).toISOString();
  const c = await act(() => api('PUT', '/admin/dev/clock', { now: target }));
  A.clockSimulated = c.simulated;
  await load();
  toast(`Now ${fmt.dt(c.now, tz())} - ${whoIs('ready').length} ready to send, ${whoIs('remind').length} reminder(s) due`);
}

/* ---------------------------------------------------------------- overview */
function pOverview(el) {
  const b = A.b;
  const st = b.tasks.filter(started);
  const done = st.filter(t => taskStatus(t) === 'done').length;
  const ready = b.tasks.filter(t => Object.values(t.assignees).some(a => a.status === 'ready'));
  const readyCount = whoIs('ready').length;
  const remind = whoIs('remind');
  const calls = whoIs('call_needed');
  const help = whoIs('help');
  const vol = b.shifts.reduce((s, x) => s + x.signups.length, 0), need = b.shifts.reduce((s, x) => s + x.need, 0);
  const issues = t => Object.entries(t.assignees).filter(([, a]) => ['help', 'call_needed', 'todo'].includes(a.status) || (overdue(t) && !['ready', 'remind', 'done'].includes(a.status)));
  const attention = b.tasks.filter(t => needsAttention(t) && (!Object.keys(t.assignees).length || issues(t).length));
  const staleBc = b.broadcasts.filter(x => hoursSince(x.sentAt) >= ackHours() && bcMissing(x).length);
  const soon = b.tasks.filter(t => t.sendAt > nowIso() && Date.parse(t.sendAt) - Date.parse(nowIso()) < 7 * 864e5);
  const activity = b.tasks.flatMap(t => (t.log || []).map(l => ({ ...l, t }))).sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 10);
  const callWhy = ({ pid, a }) => a.saved === 'scheduled' ? 'no email - call to tell them' : `no reply in ${b.event.policy.escalateAfterHours}h`;
  el.innerHTML = `
    <div class="page-h"><h2>Overview</h2></div>
    <p class="lead">Nothing goes out by itself. When a task's time comes it shows up under <b>Ready to send</b> - open it, copy the email and send it yourself, then press Mark done.
      No reply in ${b.event.policy.remindAfterHours}h: you are asked to send a reminder. No reply in ${b.event.policy.escalateAfterHours}h: you are asked to call.</p>
    <div class="grid stats">
      <div class="card stat"><div class="n" style="color:var(--blue)">${readyCount}</div><div class="l">Ready to send</div></div>
      <div class="card stat"><div class="n" style="color:var(--orange)">${remind.length}</div><div class="l">Reminders to send</div></div>
      <div class="card stat"><div class="n" style="color:var(--orange)">${calls.length}</div><div class="l">People to call</div></div>
      <div class="card stat"><div class="n" style="color:var(--red)">${help.length}</div><div class="l">Asked for help</div></div>
      <div class="card stat"><div class="n">${done}/${st.length}</div><div class="l">Started tasks done (${b.tasks.length} total)</div></div>
      <div class="card stat"><div class="n">${vol}/${need}</div><div class="l">Volunteer spots filled</div></div>
    </div>
    ${ready.length || remind.length ? `<div class="card" style="margin-top:14px">
      ${ready.length ? `<div style="display:flex;align-items:center;gap:8px"><h3 style="margin:0">Ready to send (${ready.length})</h3></div>
        ${ready.map(t => {
          const to = Object.entries(t.assignees).filter(([, a]) => a.status === 'ready').map(([pid]) => pid);
          return `<div class="row" data-task="${t.id}" style="cursor:pointer"><div class="grow"><b>${esc(t.title)}</b>${overdue(t) ? '<span class="overdue">OVERDUE</span>' : ''}
            <div class="small">To ${to.map(pid => esc(P(pid).name)).join(', ')} - since ${fmt.dt(t.sendAt, tz())}</div></div>
            <button class="btn sm">Open</button></div>`;
        }).join('')}` : ''}
      ${remind.length ? `<div style="display:flex;align-items:center;gap:8px;${ready.length ? 'margin-top:16px' : ''}"><h3 style="margin:0">No reply in ${b.event.policy.remindAfterHours}h - send a reminder (${remind.length})</h3></div>
        ${remind.map(({ t, pid, a }) => `<div class="row" data-task="${t.id}" style="cursor:pointer"><div class="grow"><b>${esc(P(pid).name)}</b> - ${esc(t.title)}
            <div class="small">Sent ${fmt.dt(a.sentAt, tz())}${P(pid).phoneDisplay ? ` - or call ${esc(P(pid).phoneDisplay)}` : ''}</div></div>
            <button class="btn sm">Open</button></div>`).join('')}` : ''}
    </div>` : ''}
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card"><h3>Needs your attention (${attention.length + staleBc.length})</h3>
        ${attention.map(t => {
          return `<div class="row" data-task="${t.id}" style="cursor:pointer"><div class="grow"><b>${esc(t.title)}</b>${overdue(t) ? '<span class="overdue">OVERDUE</span>' : ''}
            <div class="small">${!Object.keys(t.assignees).length ? `Nobody holds the role <b>${t.roles.map(roleName).join(', ')}</b> - assign someone on Team & roles` + (started(t) ? '' : ` (ready to send ${fmt.date(t.sendAt, tz())})`)
              : issues(t).map(([pid, a]) => `${esc(P(pid).name)}: ${a.status === 'call_needed' ? `${callWhy({ pid, a })} - ${P(pid).phoneDisplay ? `please call ${esc(P(pid).phoneDisplay)}` : `follow up by email ${esc(P(pid).email || '')}`}` : a.status === 'help' ? `needs help${a.note ? ` - "${esc(a.note)}"` : ''} ${P(pid).phoneDisplay ? ` - call ${esc(P(pid).phoneDisplay)}` : ''}` : a.status === 'todo' ? 'on your to-do list' : STATUS[a.status]}`).join('<br>')}</div></div>${pill(taskStatus(t))}</div>`;
        }).join('')}
        ${staleBc.map(x => `<div class="row"><div class="grow"><b>Announcement not confirmed</b><div class="small">"${esc(x.text.slice(0, 80))}" - please call ${bcMissing(x).map(pid => `${esc(P(pid).name)} ${esc(P(pid).phoneDisplay)}`).join(', ')}</div></div><a class="btn sm" href="#/e/${A.eid}/broadcast">Open</a></div>`).join('')}
        ${!attention.length && !staleBc.length ? '<div class="muted">Nothing else needs you right now.</div>' : ''}
      </div>
      <div class="card"><h3>Coming up in the next 7 days</h3>
        ${soon.map(t => `<div class="row" data-task="${t.id}" style="cursor:pointer"><div style="width:110px" class="small">${fmt.dt(t.sendAt, tz())}</div><div class="grow">${esc(t.title)}<div>${chips(t)}</div></div></div>`).join('') || '<div class="muted">Nothing coming up this week.</div>'}
        ${b.event.lastYear?.notes?.length ? `<h3 style="margin-top:16px">Notes from ${b.event.lastYear.year}</h3><ul class="small" style="padding-left:18px;margin:0">${b.event.lastYear.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      </div>
    </div>
    ${gantt()}
    <div class="card" style="margin-top:14px"><h3>Recent activity</h3>
      ${activity.map(l => `<div class="row" data-task="${l.t.id}" style="cursor:pointer"><span class="small" style="width:150px">${fmt.dt(l.at, tz())}</span><span class="grow">${esc(l.text)} <span class="small">- ${esc(l.t.title)}</span></span></div>`).join('') || '<div class="muted">Nothing yet.</div>'}
    </div>`;
  bindTaskLinks(el);
}

/** Every task as a bar from send to due, grouped by phase, with "now" and event-day markers. */
function gantt() {
  const b = A.b;
  if (!b.tasks.length) return '';
  const eventDay = Date.parse(b.event.date + 'T12:00:00Z');
  const t0 = Math.min(...b.tasks.map(t => Date.parse(t.sendAt))) - 864e5;
  const t1 = Math.max(eventDay, ...b.tasks.map(t => Date.parse(t.dueAt))) + 864e5;
  const x = ms => ((ms - t0) / (t1 - t0) * 100).toFixed(2);
  const per = Math.ceil((t1 - t0) / 864e5 / 8); // about 8 date labels across
  const step = per > 3 ? Math.ceil(per / 7) * 7 : per;
  const ticks = [];
  for (let d = eventDay; d >= t0; d -= step * 864e5) ticks.push(d);
  for (let d = eventDay + step * 864e5; d <= t1; d += step * 864e5) ticks.push(d);
  const now = Date.parse(nowIso());
  const marker = (ms, cls, label) => ms >= t0 && ms <= t1 ? `<div class="g-mark ${cls}" style="left:${x(ms)}%" title="${label}"></div>` : '';
  const markers = marker(now, 'now', 'Now') + marker(eventDay, 'ev', 'Event day');
  const row = t => {
    const s = taskStatus(t), a = Date.parse(t.sendAt), z = Date.parse(t.dueAt);
    return `<div class="g-row" data-task="${t.id}"><div class="g-label" title="${esc(t.title)}">${esc(t.title)}</div>
      <div class="g-track">${markers}<div class="g-bar d-${s}${overdue(t) ? ' late' : ''}" style="left:${x(a)}%;width:${x(t0 + z - a)}%"
        title="${esc(t.title)} - ${STATUS[s] || s}: ${fmt.date(t.sendAt, tz())} to ${fmt.date(t.dueAt, tz())}"></div></div></div>`;
  };
  return `<div class="card" style="margin-top:14px"><h3>Timeline</h3>
    <div class="gantt">
      <div class="g-row g-axis"><div class="g-label"></div><div class="g-track">${ticks.map(d => `<span style="left:${x(d)}%">${d === eventDay ? 'Event' : fmt.date(new Date(d).toISOString(), 'UTC').replace(/^\w+, /, '')}</span>`).join('')}</div></div>
      ${b.event.phases.map(ph => {
        const ts = b.tasks.filter(t => t.phase === ph);
        return ts.length ? `<div class="g-phase">${esc(ph)}</div>${ts.map(row).join('')}` : '';
      }).join('')}
    </div>
    <div class="small" style="margin-top:8px"><i class="g-key now"></i> Now <i class="g-key ev"></i> Event day - bars run from send to due; click one to open the task.</div></div>`;
}

function chips(t) {
  const ids = Object.keys(t.assignees);
  if (!ids.length) return `<span class="chip"><i class="dot d-unassigned"></i>${t.roles.map(roleName).join(', ')}: nobody</span>`;
  return ids.map(pid => `<span class="chip" title="${STATUS[t.assignees[pid].status]}"><i class="dot d-${t.assignees[pid].status}"></i>${esc(firstOf(P(pid)))}</span>`).join('');
}
function bindTaskLinks(el) { el.querySelectorAll('[data-task]').forEach(n => n.onclick = () => openDrawer(n.dataset.task)); }

/* ---------------------------------------------------------------- tasks */
function pTasks(el) {
  const f = A.taskFilter;
  const show = t => f === 'all' || (f === 'attention' ? needsAttention(t) : f === 'open' ? started(t) && taskStatus(t) !== 'done' : !started(t));
  el.innerHTML = `<div class="page-h"><h2>Tasks & timeline</h2>
      <span style="margin-left:auto;display:flex;gap:6px"><button class="btn sm" id="exportPdf">Export PDF</button><button class="btn sm primary" id="addTask">+ Add task</button></span></div>
    <p class="lead">When a task's time comes it is <b>Ready to send</b> - open it, copy the email and send it yourself, then press Mark done. No reply in ${A.b.event.policy.remindAfterHours}h: you are asked to send a reminder. No reply in ${A.b.event.policy.escalateAfterHours}h: you are asked to call.</p>
    <div class="filters">${[['all', 'All'], ['attention', 'Needs attention'], ['open', 'Open'], ['future', 'Not sent yet']].map(([k, l]) => `<button class="btn ${f === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    ${A.b.event.phases.map(ph => {
      const ts = A.b.tasks.filter(t => t.phase === ph && show(t));
      if (!ts.length) return '';
      return `<div class="phase"><h4>${esc(ph)}</h4>${ts.map(t => `<div class="task ${started(t) ? '' : 'future'}" data-task="${t.id}">
        <div class="when">${fmt.date(t.sendAt, tz())}<span>due ${fmt.date(t.dueAt, tz())}</span></div>
        <div><div><b>${esc(t.title)}</b>${overdue(t) ? '<span class="overdue">OVERDUE</span>' : ''}</div><div>${chips(t)}</div></div>
        <div>${pill(taskStatus(t))}</div></div>`).join('')}</div>`;
    }).join('')}`;
  el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { A.taskFilter = b.dataset.f; render(); });
  document.getElementById('addTask').onclick = () => { A.drawer = 'new'; renderDrawer(); };
  document.getElementById('exportPdf').onclick = () => act(exportTimelinePdf);
  bindTaskLinks(el);
}

/* ---------------------------------------------------------------- task drawer */
function openDrawer(tid) { A.drawer = tid; A.drawerTab = 'messages'; A.drawerPid = null; renderDrawer(); }
function closeDrawer() { A.drawer = null; document.getElementById('drawerRoot').innerHTML = ''; }
async function renderDrawer() {
  if (A.drawer === 'new') return renderNewTask();
  const t = A.b.tasks.find(x => x.id === A.drawer);
  if (!t) return closeDrawer();
  const pids = Object.keys(t.assignees);
  if (!A.drawerPid || !t.assignees[A.drawerPid]) A.drawerPid = pids[0] || null;
  const dr = document.getElementById('drawerRoot');
  const tab = A.drawerTab;
  dr.innerHTML = `<div class="scrim" id="scrim"></div><div class="drawer">
    <button class="x" id="dx">x</button>
    <div class="small">${esc(t.phase)} - ${t.kind === 'coordinator' ? 'starts' : 'ready to send'} ${fmt.dt(t.sendAt, tz())} - due ${fmt.dt(t.dueAt, tz())}</div>
    <h2 style="margin:4px 0 8px;font-size:19px">${esc(t.title)}</h2>
    <div>${pill(taskStatus(t))} ${overdue(t) ? '<span class="overdue">OVERDUE</span>' : ''} <span class="small">Role: ${t.roles.map(roleName).join(', ')}</span></div>
    <div class="card" style="margin-top:14px"><div style="display:flex;align-items:center;gap:8px"><h3 style="margin:0">People</h3>
    </div>
      ${pids.length ? pids.map(pid => {
        const a = t.assignees[pid], p = P(pid);
        const ch = t.checklist?.length ? `${t.checklist.filter(c => a.checks?.[c.id]).length}/${t.checklist.length} checked` : '';
        return `<div class="row"><div class="grow"><b>${esc(p.name)}</b> <span class="small">${esc(p.phoneDisplay || '')} ${esc(p.email || '')}</span>
          ${a.note ? `<div class="small">"${esc(a.note)}"</div>` : ''}${ch ? `<div class="small">${ch}</div>` : ''}</div>${pill(a.status)}
          ${!['done', 'called', 'scheduled'].includes(a.status) && t.kind !== 'coordinator' ? `<button class="btn sm" data-mark="called:${pid}" title="You talked to them on the phone">I called</button>` : ''}
          ${a.status !== 'done' ? `<button class="btn sm primary" data-mark="done:${pid}">Mark done</button>` : `<button class="btn sm" data-mark="todo:${pid}">Reopen</button>`}</div>`;
      }).join('') : `<div class="warnbox">Nobody holds the role <b>${t.roles.map(roleName).join(', ')}</b>. <a href="#/e/${A.eid}/team" id="goTeam">Assign someone on Team & roles</a>, then send it.</div>`}
    </div>
    <div class="tabs">${t.kind !== 'coordinator' ? '<button data-tab="messages">Message</button>' : ''}<button data-tab="log">Activity</button>${t.checklist?.length ? '<button data-tab="checklist">Checklist</button>' : ''}<button data-tab="edit">Edit</button></div>
    <div id="tabBody"></div></div>`;
  dr.querySelectorAll('[data-tab]').forEach(b => { b.classList.toggle('on', b.dataset.tab === tab); b.onclick = () => { A.drawerTab = b.dataset.tab; renderDrawer(); }; });
  document.getElementById('dx').onclick = closeDrawer;
  document.getElementById('scrim').onclick = closeDrawer;
  const goTeam = document.getElementById('goTeam'); if (goTeam) goTeam.onclick = closeDrawer;
  dr.querySelectorAll('[data-mark]').forEach(b => b.onclick = async () => {
    const [status, pid] = b.dataset.mark.split(':');
    await act(() => api('POST', `/admin/events/${A.eid}/tasks/${t.id}/assignees/${pid}`, { status }), status === 'called' ? 'Noted: you called them' : status === 'done' ? 'Marked done' : 'Reopened');
    await load();
  });
  const body = document.getElementById('tabBody');
  if (tab === 'messages' && t.kind !== 'coordinator') {
    const pv = await api('GET', `/admin/events/${A.eid}/tasks/${t.id}/preview${A.drawerPid ? `?pid=${A.drawerPid}` : ''}`);
    body.innerHTML = `${pids.length > 1 ? `<div class="filters">${pids.map(pid => `<button class="btn sm ${pid === A.drawerPid ? 'on' : ''}" data-pv="${pid}">${esc(firstOf(P(pid)))}</button>`).join('')}</div>` : ''}
      ${smsOn() ? `<div class="small" style="margin-bottom:4px">Text message</div><div class="sms-bubble">${linkify(pv.sms)}</div>` : ''}
      <div class="small" style="margin:14px 0 4px">Email - subject: <b>${esc(pv.subject)}</b></div>
      <div style="display:flex;gap:6px;margin-bottom:6px"><button class="btn sm primary" id="copySubject">Copy subject</button><button class="btn sm primary" id="copyBody">Copy email body</button></div>
      <pre class="mail">${linkify(pv.body)}</pre>`;
    document.getElementById('copySubject').onclick = () => { navigator.clipboard.writeText(pv.subject); toast('Subject copied'); };
    document.getElementById('copyBody').onclick = () => { navigator.clipboard.writeText(pv.body); toast('Email body copied'); };
    body.querySelectorAll('[data-pv]').forEach(b => b.onclick = () => { A.drawerPid = b.dataset.pv; renderDrawer(); });
  } else if (tab === 'log') {
    body.innerHTML = (t.log || []).length ? `<div class="log">${t.log.map(l => `<div class="k-${l.kind}"><b>${fmt.dt(l.at, tz())}</b> ${esc(l.text)}</div>`).join('')}</div>` : `<div class="muted">Nothing yet - ready to send ${fmt.dt(t.sendAt, tz())}.</div>`;
  } else if (tab === 'checklist') {
    body.innerHTML = `<table><tr><th>Item</th>${pids.map(pid => `<th>${esc(firstOf(P(pid)))}</th>`).join('')}</tr>${t.checklist.map(c => `<tr><td>${esc(c.text)}</td>${pids.map(pid => `<td>${t.assignees[pid].checks?.[c.id] ? 'Yes' : '-'}</td>`).join('')}</tr>`).join('')}</table>
      <div class="small" style="margin-top:6px">People tick these off on their personal page.</div>`;
  } else if (tab === 'edit') {
    body.innerHTML = `<form id="editTask" class="grid" style="gap:10px">${taskFormFields(t)}
      <div style="display:flex;gap:8px"><button class="btn primary">Save changes</button>
        <button type="button" class="btn danger" id="delTask" style="margin-left:auto">Delete task</button></div></form>`;
    bindTaskForm(document.getElementById('editTask'), async f => {
      await act(() => api('PUT', `/admin/events/${A.eid}/tasks/${t.id}`, f), 'Saved');
      await load();
    });
    document.getElementById('delTask').onclick = async () => {
      if (!confirm(`Delete "${t.title}"?${Object.values(t.assignees).some(a => a.saved !== 'scheduled') ? ' It has already been sent.' : ''}`)) return;
      await act(() => api('DELETE', `/admin/events/${A.eid}/tasks/${t.id}`), 'Task deleted');
      closeDrawer(); await load();
    };
  }
}

const localDt = iso => new Date(iso).toLocaleString('sv-SE', { timeZone: tz() }).slice(0, 16).replace(' ', 'T');

/** Shared fields of the add-task and edit-task forms. */
function taskFormFields(t) {
  const roles = t.roles || [];
  const shop = t.shoppingStores || [];
  const stores = [...new Set([...A.b.shopping.map(i => i.store), ...shop])];
  return `<div class="field"><label>Title - what needs to be done</label><input name="title" required value="${esc(t.title || '')}"></div>
    <div class="formgrid">
      <div class="field"><label>Goes out (${esc(tz())})</label><input type="datetime-local" name="sendAt" required value="${localDt(t.sendAt)}"></div>
      <div class="field"><label>Due (${esc(tz())})</label><input type="datetime-local" name="dueAt" required value="${localDt(t.dueAt)}"></div>
      <div class="field"><label>Phase</label><select name="phase">${A.b.event.phases.map(ph => `<option ${ph === t.phase ? 'selected' : ''}>${esc(ph)}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Who - the role(s) doing it</label><div class="rolebox">${A.b.event.roles.map(r => `<label class="${roles.includes(r.key) ? 'on' : ''}"><input type="checkbox" data-trole="${r.key}" ${roles.includes(r.key) ? 'checked' : ''}>${esc(r.name)}</label>`).join('')}</div></div>
    <div class="field"><label>Checklist (one item per line, optional)</label><textarea name="checklist" rows="3">${esc((t.checklist || []).map(c => c.text).join('\n'))}</textarea></div>
    ${t.kind === 'coordinator' ? '' : `
    <div class="field"><label>Shopping list - stores whose items show on their page (optional)</label>${stores.length ? `<div class="rolebox">${stores.map(s => `<label class="${shop.includes(s) ? 'on' : ''}"><input type="checkbox" data-tstore="${esc(s)}" ${shop.includes(s) ? 'checked' : ''}>${esc(s)}</label>`).join('')}</div>` : '<div class="small">No shopping items yet - add some on the Shopping list page.</div>'}</div>
    ${smsOn() ? `<div class="field"><label>Text message (optional - a default is used when empty; the reply instructions are added automatically)</label><textarea name="sms" rows="3">${esc(t.sms || '')}</textarea></div>` : ''}
    <div class="field"><label>Email subject (optional - the title is used when empty)</label><input name="emailSubject" value="${esc(t.email?.subject || '')}"></div>
    <div class="field"><label>Email body</label><textarea name="emailBody" rows="10" class="mono">${esc(t.email?.body || '')}</textarea></div>
    <div class="small">Placeholders: {{first}} {{link}} {{venue}} {{date -1}} {{mdy 0}} {{signature}} {{coord.first}} {{coord.phone}}</div>`}`;
}
function bindTaskForm(form, save) {
  form.querySelectorAll('[data-trole], [data-tstore]').forEach(c => c.onchange = () => c.parentElement.classList.toggle('on', c.checked));
  const kind = form.querySelector('[name=kind]');
  if (kind) kind.onchange = () => { A.newKind = kind.value; renderNewTask(); };
  form.onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    f.sendAt = zonedToIso(f.sendAt, tz()); f.dueAt = zonedToIso(f.dueAt, tz());
    f.roles = [...form.querySelectorAll('[data-trole]:checked')].map(c => c.dataset.trole);
    f.checklist = f.checklist.split('\n');
    if (form.querySelector('[data-tstore]')) f.shoppingStores = [...form.querySelectorAll('[data-tstore]:checked')].map(c => c.dataset.tstore);
    if (!f.roles.length) return toast('Pick at least one role', true);
    await save(f);
  };
}
function renderNewTask() {
  const kind = A.newKind || 'message';
  const dayAt = (days, hm) => zonedToIso(`${localDt(new Date(Date.parse(nowIso()) + days * 864e5).toISOString()).slice(0, 10)}T${hm}`, tz());
  const draft = { kind, phase: A.b.event.phases[0], roles: [], sendAt: dayAt(1, '09:00'), dueAt: dayAt(4, '21:00') };
  document.getElementById('drawerRoot').innerHTML = `<div class="scrim" id="scrim"></div><div class="drawer">
    <button class="x" id="dx">x</button><h2 style="margin:4px 0 12px;font-size:19px">New task</h2>
    <form id="newTask" class="grid" style="gap:10px">
      <div class="field"><label>Type</label><select name="kind">
        <option value="message" ${kind === 'message' ? 'selected' : ''}>${smsOn() ? 'Text and email' : 'Email'} the people in the role at the send time</option>
        <option value="coordinator" ${kind === 'coordinator' ? 'selected' : ''}>A to-do on the dashboard only (no message)</option></select></div>
      ${taskFormFields(draft)}
      <div><button class="btn primary">Add task</button></div></form></div>`;
  document.getElementById('dx').onclick = closeDrawer;
  document.getElementById('scrim').onclick = closeDrawer;
  bindTaskForm(document.getElementById('newTask'), async f => {
    const t = await act(() => api('POST', `/admin/events/${A.eid}/tasks`, f), 'Task added');
    A.newKind = null; A.drawer = t.id; A.drawerTab = 'log';
    await load();
  });
}

/* ---------------------------------------------------------------- timeline PDF */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const el = document.createElement('script');
    el.src = src; el.onload = resolve; el.onerror = () => reject(new Error('Could not load the PDF library - check the internet connection'));
    document.head.appendChild(el);
  });
}
async function exportTimelinePdf() {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
  const b = A.b, ev = b.event, z = tz();
  const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
  const green = [31, 77, 58], M = 40;
  const names = pids => pids.map(pid => P(pid).name).join(', ');
  const day = iso => new Date(iso).toLocaleDateString('en-US', { timeZone: z, weekday: 'short', month: 'short', day: 'numeric' });
  const table = (y, opts) => { doc.autoTable({ startY: y, margin: { left: M, right: M }, styles: { fontSize: 8.5, cellPadding: 4, valign: 'top' }, headStyles: { fillColor: green }, ...opts }); return doc.lastAutoTable.finalY; };
  // a heading near the page bottom moves to the next page with its table
  const heading = (y, text) => { if (y > 640) { doc.addPage(); y = M; } doc.setFontSize(13).setTextColor(...green).text(text, M, y + 22); doc.setTextColor(0); return y + 30; };

  doc.setFontSize(17).text(ev.name, M, 50);
  doc.setFontSize(10).setTextColor(90).text(`${fmt.ymd(ev.date)} - ${ev.venue} - ${ev.organization}`, M, 68)
    .text(`Plan as of ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} - all times ${z}`, M, 82);
  doc.setTextColor(0);

  let y = heading(90, 'Who is who');
  y = table(y, {
    head: [['Role', 'People', 'Contact']],
    body: ev.roles.map(r => {
      const ids = ev.assignments?.[r.key] || [];
      return [{ content: `${r.name}\n${r.description || ''}`.trim() }, names(ids) || 'NOBODY YET', ids.map(pid => [P(pid).phoneDisplay, P(pid).email].filter(Boolean).join('  ')).join('\n')];
    }),
    columnStyles: { 0: { cellWidth: 190 }, 1: { cellWidth: 130 } },
    didParseCell: d => { if (d.section === 'body' && d.column.index === 1 && d.cell.raw === 'NOBODY YET') d.cell.styles.textColor = [180, 40, 30]; },
  });

  y = heading(y, 'Timeline - who does what, when');
  const body = [];
  for (const ph of ev.phases) {
    const ts = b.tasks.filter(t => t.phase === ph);
    if (!ts.length) continue;
    body.push([{ content: ph.toUpperCase(), colSpan: 5, styles: { fillColor: [238, 234, 222], fontStyle: 'bold' } }]);
    for (const t of ts) {
      const what = [t.title, ...(t.checklist || []).map(c => `  - ${c.text}`)].join('\n');
      const who = Object.keys(t.assignees);
      body.push([day(t.sendAt), day(t.dueAt), what, `${t.roles.map(roleName).join(', ')}${who.length ? `\n${names(who)}` : '\n(nobody yet)'}`, STATUS[taskStatus(t)] || taskStatus(t)]);
    }
  }
  y = table(y, { head: [['Starts', 'Due', 'What', 'Who', 'Status']], body, columnStyles: { 0: { cellWidth: 62 }, 1: { cellWidth: 62 }, 3: { cellWidth: 130 }, 4: { cellWidth: 62 } } });

  if (b.shifts.length) {
    y = heading(y, 'Volunteer shifts');
    table(y, {
      head: [['Shift', 'When', 'Signed up', 'Volunteers']],
      body: b.shifts.map(s => [s.name, `${fmt.dt(s.startAt, z)} - ${fmt.time(s.endAt, z)}`, `${s.signups.length} of ${s.need}`, names(s.signups.map(x => x.pid)) || '-']),
      columnStyles: { 0: { cellWidth: 150 }, 1: { cellWidth: 130 }, 2: { cellWidth: 60 } },
    });
  }
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(8).setTextColor(130).text(`${ev.name} - page ${i} of ${pages}`, M, 772); }
  doc.save(`${ev.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-')}-timeline.pdf`);
}

/** 'YYYY-MM-DDTHH:MM' wall time in tz -> ISO. */
function zonedToIso(local, zone) {
  const [d, hm] = local.split('T');
  const [y, m, dd] = d.split('-').map(Number); const [H, M] = hm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, dd, H, M);
  const off = ts => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ts)).map(x => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ts; };
  return new Date(guess - off(guess - off(guess))).toISOString();
}

/* ---------------------------------------------------------------- team */
function pTeam(el) {
  const b = A.b;
  const people = Object.values(b.people).sort((x, y) => x.name.localeCompare(y.name));
  const asg = structuredClone(b.event.assignments || {});
  el.innerHTML = `<div class="page-h"><h2>Team & roles</h2></div>
    <p class="lead">The playbook only knows roles. Each year, put people in the roles here; their tasks follow them. Someone missing? <a href="#/e/${A.eid}/contacts">Add them to Contacts</a> first.</p>
    <div class="card"><h3>Who holds which role</h3><table>
      ${b.event.roles.map(r => `<tr><td style="width:230px"><b>${esc(r.name)}</b><div class="small">${esc(r.description || '')}</div>
          <div style="margin-top:4px"><button class="btn sm" data-redit="${r.key}">Edit</button>${r.key === 'coordinator' ? '' : ` <button class="btn sm danger" data-rdel="${r.key}">Delete</button>`}</div></td>
        <td><div class="rolebox">${people.map(p => `<label class="${(asg[r.key] || []).includes(p.id) ? 'on' : ''}"><input type="checkbox" data-role="${r.key}" value="${p.id}" ${(asg[r.key] || []).includes(p.id) ? 'checked' : ''}>${esc(p.name)}</label>`).join('')}</div>
        ${!(asg[r.key] || []).length ? '<div class="small" style="color:var(--red);margin-top:4px">Nobody - tasks for this role have no one to send to</div>' : ''}</td></tr>`).join('')}
    </table><div style="margin-top:10px"><button class="btn primary" id="saveRoles">Save roles</button> <span class="small">Anyone newly added to a task that is already due shows up under Ready to send on the Overview.</span></div></div>
    <div class="card" style="margin-top:14px"><h3>Add a role</h3>
      <form id="addRole" style="display:flex;gap:8px;flex-wrap:wrap"><input name="name" placeholder="Role name, e.g. Music" required style="flex:1;min-width:180px">
        <input name="description" placeholder="What this role does (optional)" style="flex:2;min-width:220px"><button class="btn primary">Add role</button></form>
      <div class="small" style="margin-top:6px">Then give the role tasks on Tasks & timeline. A role that still has tasks cannot be deleted - move or delete its tasks first.</div></div>`;
  el.querySelectorAll('[data-role]').forEach(c => c.onchange = () => c.parentElement.classList.toggle('on', c.checked));
  document.getElementById('saveRoles').onclick = async () => {
    const next = Object.fromEntries(b.event.roles.map(r => [r.key, [...el.querySelectorAll(`[data-role="${r.key}"]:checked`)].map(c => c.value)]));
    await act(() => api('PUT', `/admin/events/${A.eid}/assignments`, next), 'Roles saved');
    await load();
  };
  document.getElementById('addRole').onsubmit = async e => {
    e.preventDefault();
    await act(() => api('POST', `/admin/events/${A.eid}/roles`, Object.fromEntries(new FormData(e.target))), 'Role added');
    await load();
  };
  el.querySelectorAll('[data-redit]').forEach(bt => bt.onclick = async () => {
    const r = b.event.roles.find(x => x.key === bt.dataset.redit);
    const name = prompt('Role name', r.name); if (name === null) return;
    const description = prompt('What this role does', r.description || ''); if (description === null) return;
    await act(() => api('PUT', `/admin/events/${A.eid}/roles/${r.key}`, { name, description }), 'Role updated');
    await load();
  });
  el.querySelectorAll('[data-rdel]').forEach(bt => bt.onclick = async () => {
    const r = b.event.roles.find(x => x.key === bt.dataset.rdel);
    if (!confirm(`Delete the role "${r.name}"? People in it stay on the contact list.`)) return;
    await act(() => api('DELETE', `/admin/events/${A.eid}/roles/${r.key}`), 'Role deleted');
    await load();
  });
}

/* ---------------------------------------------------------------- contacts */
function pContacts(el) {
  const b = A.b;
  const people = Object.values(b.people).sort((x, y) => x.name.localeCompare(y.name));
  const inEvent = pid => [
    ...b.event.roles.filter(r => (b.event.assignments?.[r.key] || []).includes(pid)).map(r => r.name),
    ...b.shifts.filter(s => s.signups.some(x => x.pid === pid)).map(s => `Volunteer: ${s.name}`),
  ];
  el.innerHTML = `<div class="page-h"><h2>Contacts</h2></div>
    <p class="lead">Everyone - core team and volunteers - goes on this list first. It is shared by all events; roles, volunteer shifts and announcements all pick people from here.
      The system reaches people by email; anyone without an email lands on your call list.</p>
    <label class="small" style="display:block;margin-bottom:12px"><input type="checkbox" id="smsToggle" ${smsOn() ? 'checked' : ''}> Also send text messages for this event (needs a registered SMS number)</label>
    <div class="card"><table><tr><th>Name</th><th>Reach by</th><th>Phone / email</th><th>In this event</th><th>Personal link</th><th></th></tr>
      ${people.map(p => {
        const tok = b.event.tokens?.[p.id];
        const ch = !smsOn() ? (noEmail(p) ? 'You call' : 'email')
          : p.mobile === false ? 'Landline - you call' : (p.channels || []).map(c => (c === 'sms' && p.smsOptIn === false ? 'text (opted out)' : c === 'sms' ? 'text' : c)).join(' + ') || 'You call';
        return `<tr><td><b>${esc(p.name)}</b><div class="small">${esc(p.notes || '')}</div></td><td>${esc(ch)}</td>
          <td>${esc(p.phoneDisplay || '')}<div class="small">${esc(p.email || '')}</div></td>
          <td class="small">${inEvent(p.id).map(esc).join('<br>') || '-'}</td>
          <td>${tok ? `<button class="btn sm" data-copy="${esc(location.origin + location.pathname.replace(/index\.html$/, '') + 'p.html?t=' + tok)}">Copy link</button> <a class="btn sm" target="_blank" href="p.html?t=${tok}">Open</a>` : '<span class="small">Sent with the first task</span>'}</td>
          <td><button class="btn sm" data-edit="${p.id}">Edit</button></td></tr>`;
      }).join('') || '<tr><td colspan="6" class="muted">No contacts yet.</td></tr>'}</table>
      <div style="margin-top:10px"><button class="btn" data-edit="">+ Add a contact</button></div>
      <div id="personForm"></div></div>`;
  el.querySelectorAll('[data-copy]').forEach(bt => bt.onclick = () => { navigator.clipboard.writeText(bt.dataset.copy); toast('Link copied'); });
  el.querySelectorAll('[data-edit]').forEach(bt => bt.onclick = () => personForm(bt.dataset.edit));
  document.getElementById('smsToggle').onchange = async e => { await act(() => api('PUT', `/admin/events/${A.eid}`, { sms: e.target.checked }), e.target.checked ? 'Texts on' : 'Email only'); await load(); };
}
function personForm(pid) {
  const p = pid ? A.b.people[pid] : { channels: ['sms', 'email'], mobile: true, smsOptIn: true };
  const box = document.getElementById('personForm');
  box.innerHTML = `<form class="card" style="margin-top:12px;background:var(--bg)" id="pf"><h3>${pid ? 'Edit ' + esc(p.name) : 'New contact'}</h3>
    <div class="formgrid">
      <div class="field"><label>Full name</label><input name="name" required value="${esc(p.name || '')}"></div>
      <div class="field"><label>First name used in messages (optional)</label><input name="firstName" value="${esc(p.firstName || '')}"></div>
      <div class="field"><label>Phone${smsOn() ? '' : ' (for calls and your own group texts)'}</label><input name="phone" value="${esc(p.phoneDisplay || '')}" placeholder="(504) 555-0100"></div>
      <div class="field"><label>Email</label><input name="email" type="email" value="${esc(p.email || '')}"></div>
    </div>
    <div style="display:flex;gap:18px;flex-wrap:wrap;margin:10px 0">
      <span style="display:${smsOn() ? 'contents' : 'none'}">
      <label><input type="checkbox" name="mobile" ${p.mobile !== false ? 'checked' : ''}> Phone can receive texts (not a landline)</label>
      <label><input type="checkbox" name="smsOptIn" ${p.smsOptIn !== false ? 'checked' : ''}> Agreed to receive texts</label>
      <label><input type="checkbox" name="ch_sms" ${(p.channels || []).includes('sms') ? 'checked' : ''}> Send texts</label></span>
      <label><input type="checkbox" name="ch_email" ${(p.channels || []).includes('email') ? 'checked' : ''}> Send emails</label>
    </div>
    <div class="field"><label>Notes</label><input name="notes" value="${esc(p.notes || '')}"></div>
    <div style="margin-top:10px;display:flex;gap:8px"><button class="btn primary">Save</button><button type="button" class="btn" id="pfCancel">Cancel</button>
    ${pid ? '<button type="button" class="btn danger" id="pfDel" style="margin-left:auto">Delete contact</button>' : ''}</div></form>`;
  box.scrollIntoView({ behavior: 'smooth' });
  document.getElementById('pfCancel').onclick = () => { box.innerHTML = ''; };
  const del = document.getElementById('pfDel');
  if (del) del.onclick = async () => { if (!confirm(`Delete ${p.name}? Remove them from roles and volunteer shifts first.`)) return; await act(() => api('DELETE', `/admin/people/${pid}`), 'Deleted'); await load(); };
  document.getElementById('pf').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
      name: f.get('name'), firstName: f.get('firstName'), phone: f.get('phone'), email: f.get('email'), notes: f.get('notes'),
      mobile: f.get('mobile') === 'on', smsOptIn: f.get('smsOptIn') === 'on',
      channels: [f.get('ch_sms') === 'on' && 'sms', f.get('ch_email') === 'on' && 'email'].filter(Boolean),
    };
    if (!body.channels.length) body.channels = [];
    await act(() => (pid ? api('PUT', `/admin/people/${pid}`, body) : api('POST', '/admin/people', body)), 'Saved');
    await load();
  };
}

/* ---------------------------------------------------------------- shifts */
function pShifts(el) {
  const b = A.b;
  const people = Object.values(b.people).sort((x, y) => x.name.localeCompare(y.name));
  el.innerHTML = `<div class="page-h"><h2>Volunteer shifts</h2></div>
    <p class="lead">When someone offers to help (by phone, text or email), pick them here. Not on the list yet? <a href="#/e/${A.eid}/contacts">Add them to Contacts</a> first.</p>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">
    ${b.shifts.map(s => {
      const n = s.signups.length;
      const free = people.filter(p => !s.signups.some(x => x.pid === p.id));
      return `<div class="card"><b>${esc(s.name)}</b><div class="small">${fmt.dt(s.startAt, tz())} - ${fmt.time(s.endAt, tz())}</div>
        <div style="display:flex;justify-content:space-between;margin:8px 0 4px"><span>${n} of ${s.need}</span>
          <span class="small">need <input type="number" min="0" value="${s.need}" data-need="${s.id}" style="width:64px;padding:2px 6px"></span></div>
        <div class="bar ${n < s.need * 0.6 ? 'low' : ''}"><div style="width:${Math.min(100, n / Math.max(1, s.need) * 100)}%"></div></div>
        <div style="margin-top:8px">${s.signups.map(x => `<div class="row"><span class="grow">${esc(P(x.pid).name)} <span class="small">${esc(P(x.pid).phoneDisplay || '')}</span></span><button class="btn sm danger" data-rm="${s.id}:${x.id}">Remove</button></div>`).join('') || '<div class="small">Nobody yet</div>'}</div>
        <form data-add="${s.id}" style="display:flex;gap:6px;margin-top:8px"><select name="pid" required><option value="">Pick a contact...</option>${free.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select><button class="btn sm">Add</button></form></div>`;
    }).join('')}</div>`;
  el.querySelectorAll('[data-need]').forEach(i => i.onchange = async () => { await act(() => api('PUT', `/admin/events/${A.eid}/shifts/${i.dataset.need}`, { need: i.value }), 'Updated'); await load(); });
  el.querySelectorAll('[data-rm]').forEach(bt => bt.onclick = async () => { const [sid, su] = bt.dataset.rm.split(':'); await act(() => api('DELETE', `/admin/events/${A.eid}/shifts/${sid}/signups/${su}`), 'Removed'); await load(); });
  el.querySelectorAll('[data-add]').forEach(f => f.onsubmit = async e => { e.preventDefault(); await act(() => api('POST', `/admin/events/${A.eid}/shifts/${f.dataset.add}/signups`, Object.fromEntries(new FormData(f))), 'Added'); await load(); });
}

/* ---------------------------------------------------------------- broadcast */
function pBroadcast(el) {
  const b = A.b;
  const people = Object.values(b.people).sort((x, y) => x.name.localeCompare(y.name));
  el.innerHTML = `<div class="page-h"><h2>Announcements</h2></div>
    <p class="lead">When the plan changes, write one sentence and pick who needs to know. Everyone gets it by ${smsOn() ? 'text and email and is asked to reply 1' : 'email with a link to confirm'}. Anyone who has not confirmed after ${ackHours()}h shows up on your call list.</p>
    <div class="grid cols-2">
      <div class="card"><h3>New announcement</h3>
        <textarea id="bcText" rows="4" placeholder="Example: Saturday set-up now starts at 2:30 PM because the Christmas Market closes early."></textarea>
        <div class="small" style="margin:10px 0 4px">Send to everyone in these roles</div>
        <div class="rolebox">${b.event.roles.map(r => `<label><input type="checkbox" data-bcrole="${r.key}"> ${esc(r.name)}</label>`).join('')}</div>
        <div class="small" style="margin:10px 0 4px">...the volunteers in these shifts</div>
        <div class="rolebox">${b.shifts.map(s => `<label><input type="checkbox" data-bcshift="${s.id}"> ${esc(s.name)} (${s.signups.length})</label>`).join('')}</div>
        <div class="small" style="margin:10px 0 4px">...and/or these people</div>
        <div class="rolebox">${people.map(p => `<label><input type="checkbox" data-bcp="${p.id}"> ${esc(p.name)}</label>`).join('')}</div>
        <div class="small" id="bcWho" style="margin-top:10px"></div>
        <div class="small" style="margin:10px 0 4px">${smsOn() ? 'Text preview' : 'Email preview'}</div><div class="sms-bubble" id="bcPrev" style="white-space:pre-wrap"></div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="bcSend">Send announcement</button>
          <button class="btn" id="bcPhones" title="Paste into your phone to text this group yourself">Copy phone numbers</button></div></div>
      <div class="card"><h3>Sent</h3>${b.broadcasts.slice().reverse().map(x => {
        const miss = bcMissing(x); const late = hoursSince(x.sentAt) >= ackHours();
        return `<div class="row" style="display:block"><div class="small">${fmt.dt(x.sentAt, tz())} - ${x.to.length - miss.length}/${x.to.length} confirmed</div>
          <div style="margin:4px 0 6px">${esc(x.text)}</div>
          <div class="bar"><div style="width:${(x.to.length - miss.length) / x.to.length * 100}%"></div></div>
          <div style="margin-top:6px">${x.to.map(pid => { const ok = x.acks[pid]; const needCall = !ok && (late || !A.b.people[pid] || unreachable(A.b.people[pid]));
            return `<span class="chip" title="${ok ? `confirmed via ${ok.by}` : needCall ? 'please call' : 'waiting'}"><i class="dot d-${ok ? 'done' : needCall ? 'call_needed' : 'sent'}"></i>${esc(firstOf(P(pid)))}</span>`; }).join('')}</div>
          ${miss.length ? `<div class="small" style="margin-top:6px">${late ? '<b style="color:var(--orange)">Please call:</b> ' : 'Waiting for: '}${miss.map(pid => `${esc(P(pid).name)} ${esc(P(pid).phoneDisplay || '')} <button class="btn sm" data-ack="${x.id}:${pid}">I told them</button>`).join(' ')}</div>` : ''}
        </div>`;
      }).join('') || '<div class="muted">No announcements yet.</div>'}</div>
    </div>`;
  const who = () => {
    const roles = [...el.querySelectorAll('[data-bcrole]:checked')].map(c => c.dataset.bcrole);
    const shifts = [...el.querySelectorAll('[data-bcshift]:checked')].map(c => c.dataset.bcshift);
    return [...new Set([
      ...roles.flatMap(r => b.event.assignments[r] || []),
      ...b.shifts.filter(s => shifts.includes(s.id)).flatMap(s => s.signups.map(x => x.pid)),
      ...[...el.querySelectorAll('[data-bcp]:checked')].map(c => c.dataset.bcp),
    ])];
  };
  const upd = () => {
    const ids = who();
    document.getElementById('bcWho').innerHTML = ids.length ? `Goes to ${ids.length}: ${ids.map(pid => esc(P(pid).name) + (unreachable(P(pid)) ? ' (no email - you call)' : '')).join(', ')}` : 'Pick at least one role, shift or person.';
    const msg = document.getElementById('bcText').value || '...';
    document.getElementById('bcPrev').textContent = smsOn()
      ? `${b.event.baseName || b.event.name} update from ${firstOf(P((b.event.assignments.coordinator || [])[0]) || {})}: ${msg} Reply 1 to confirm you got this.`
      : `Subject: Update: ${b.event.baseName || b.event.name}\n\n${msg}\n\nPlease tap here to confirm you got this: (their personal link)`;
  };
  el.querySelectorAll('input[type=checkbox]').forEach(c => c.onchange = () => { c.parentElement.classList.toggle('on', c.checked); upd(); });
  document.getElementById('bcText').oninput = upd;
  upd();
  document.getElementById('bcPhones').onclick = () => {
    const nums = who().map(pid => P(pid).phoneDisplay).filter(Boolean);
    if (!nums.length) return toast('Nobody picked has a phone number', true);
    navigator.clipboard.writeText(nums.join(', '));
    toast(`Copied ${nums.length} phone number(s)`);
  };
  document.getElementById('bcSend').onclick = async () => {
    const pids = who(); const text = document.getElementById('bcText').value;
    if (!confirm(`Send this to ${pids.length} people now?`)) return;
    await act(() => api('POST', `/admin/events/${A.eid}/broadcasts`, { text, pids }), 'Announcement sent');
    await load();
  };
  el.querySelectorAll('[data-ack]').forEach(bt => bt.onclick = async () => { const [bid, pid] = bt.dataset.ack.split(':'); await act(() => api('POST', `/admin/events/${A.eid}/broadcasts/${bid}/acks/${pid}`), 'Marked confirmed'); await load(); });
}

/* ---------------------------------------------------------------- shopping */
function pShopping(el) {
  const items = A.b.shopping;
  const stores = [...new Set(items.map(i => i.store))];
  const bought = items.filter(i => i.bought).length;
  el.innerHTML = `<div class="page-h"><h2>Shopping list</h2><span class="muted">${bought}/${items.length} bought</span>
      <button class="btn sm noprint" style="margin-left:auto" onclick="window.print()">Print</button></div>
    <p class="lead">Quantities start from the playbook (already adjusted from last year's leftovers - highlighted). The shopper ticks items off on their phone.</p>
    ${stores.map(s => `<div class="card" style="margin-bottom:14px"><h3>${esc(s)}</h3><table>
      <tr><th style="width:38px">Got</th><th>Item</th><th>Last year</th><th style="width:150px">This year</th><th>Note</th><th class="noprint"></th></tr>
      ${items.filter(i => i.store === s).map(i => `<tr class="${i.qty !== i.lastQty && i.lastQty ? 'changed' : ''}">
        <td><input type="checkbox" data-bought="${i.id}" ${i.bought ? 'checked' : ''} title="${i.boughtBy ? 'by ' + esc(P(i.boughtBy).name || i.boughtBy) : ''}"></td>
        <td>${esc(i.name)}${i.bought && i.boughtBy ? `<div class="small">bought by ${esc(i.boughtBy === 'coordinator' ? 'you' : P(i.boughtBy).name)}</div>` : ''}</td>
        <td class="qty-old">${esc(i.lastQty || '')}</td>
        <td><input value="${esc(i.qty)}" data-qty="${i.id}" style="padding:3px 7px"></td>
        <td><input value="${esc(i.note || '')}" data-note="${i.id}" style="padding:3px 7px"></td>
        <td class="noprint"><button class="btn sm danger" data-del="${i.id}">x</button></td></tr>`).join('')}
    </table></div>`).join('')}
    <form class="card noprint" id="addItem" style="display:flex;gap:8px;align-items:end;flex-wrap:wrap">
      <div class="field"><label>Store</label><input name="store" list="stores" required></div><datalist id="stores">${stores.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
      <div class="field" style="flex:2"><label>Item</label><input name="name" required></div>
      <div class="field"><label>Quantity</label><input name="qty"></div>
      <div class="field" style="flex:2"><label>Note</label><input name="note"></div>
      <button class="btn primary">Add item</button></form>`;
  el.querySelectorAll('[data-bought]').forEach(c => c.onchange = async () => { await act(() => api('PUT', `/admin/events/${A.eid}/shopping/${c.dataset.bought}`, { bought: c.checked })); await load(); });
  el.querySelectorAll('[data-qty]').forEach(i => i.onchange = async () => { await act(() => api('PUT', `/admin/events/${A.eid}/shopping/${i.dataset.qty}`, { qty: i.value }), 'Saved'); await load(); });
  el.querySelectorAll('[data-note]').forEach(i => i.onchange = async () => { await act(() => api('PUT', `/admin/events/${A.eid}/shopping/${i.dataset.note}`, { note: i.value }), 'Saved'); await load(); });
  el.querySelectorAll('[data-del]').forEach(bt => bt.onclick = async () => { if (!confirm('Remove this item?')) return; await act(() => api('DELETE', `/admin/events/${A.eid}/shopping/${bt.dataset.del}`)); await load(); });
  document.getElementById('addItem').onsubmit = async e => { e.preventDefault(); await act(() => api('POST', `/admin/events/${A.eid}/shopping`, Object.fromEntries(new FormData(e.target))), 'Added'); await load(); };
}

/* ---------------------------------------------------------------- results & report */
function pResults(el) {
  const b = A.b;
  const r = b.results || { fields: {}, expenses: [], lessons: '' };
  const ex = r.expenses || [];
  const total = ex.reduce((s, x) => s + x.amount, 0);
  const donated = ex.filter(x => x.donated).reduce((s, x) => s + x.amount, 0);
  const owed = Object.entries(ex.filter(x => !x.donated && !x.reimbursed).reduce((m, x) => ({ ...m, [x.who]: (m[x.who] || 0) + x.amount }), {}));
  const missing = b.event.resultsForm.flatMap(g => g.fields).filter(f => !String(r.fields?.[f.key] ?? '').trim() || String(r.fields[f.key]).includes('?'));
  el.innerHTML = `<div class="page-h"><h2>Results & report</h2>
      <button class="btn sm noprint" style="margin-left:auto" onclick="window.print()">Print report</button></div>
    <p class="lead">The results counter fills this in on their phone at the end of the party (you can too). Every field is required - it sets next year's quantities.</p>
    ${r.submittedAt ? `<div class="infobox" style="margin-bottom:14px">Last saved ${fmt.dt(r.submittedAt, tz())} by ${esc(r.submittedBy === 'coordinator' ? 'you' : P(r.submittedBy).name)}. ${missing.length ? `<b>${missing.length} field(s) still missing.</b>` : 'All fields filled in.'}</div>` : ''}
    <form id="resForm">${b.event.resultsForm.map(g => `<div class="card" style="margin-bottom:14px"><h3>${esc(g.group)}</h3><div class="formgrid">
      ${g.fields.map(f => `<div class="field"><label>${esc(f.label)} <span style="float:right">last year: ${f.last === '?' ? '<b style="color:var(--red)">not counted</b>' : esc(f.last)}</span></label><input name="${f.key}" value="${esc(r.fields?.[f.key] ?? '')}"></div>`).join('')}
    </div></div>`).join('')}
    <div class="card" style="margin-bottom:14px"><h3>Lessons for next year</h3><textarea name="lessons" rows="4" placeholder="One per line, e.g. 'Rice: 10 lb was right'">${esc(r.lessons || '')}</textarea></div>
    <div class="noprint" style="margin-bottom:22px"><button class="btn primary">Save results</button></div></form>

    <div class="card" style="margin-bottom:14px"><h3>Expenses & reimbursement</h3>
      <table><tr><th>Paid by</th><th>Store</th><th>Amount</th><th>Receipt</th><th>Donated</th><th>Reimbursed</th><th class="noprint"></th></tr>
      ${ex.map(x => `<tr><td>${esc(x.who)}</td><td>${esc(x.vendor)}${x.note ? `<div class="small">${esc(x.note)}</div>` : ''}</td><td>${fmt.money(x.amount)}</td>
        <td>${x.receiptKey ? `<button class="btn sm" data-receipt="${x.id}">View</button>` : '<span class="small">-</span>'}</td>
        <td><input type="checkbox" data-xflag="${x.id}:donated" ${x.donated ? 'checked' : ''}></td>
        <td><input type="checkbox" data-xflag="${x.id}:reimbursed" ${x.reimbursed ? 'checked' : ''}></td>
        <td class="noprint"><button class="btn sm danger" data-xdel="${x.id}">x</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No expenses yet. The shopper uploads receipts from their personal page.</td></tr>'}
      </table>
      <div style="display:flex;gap:24px;margin-top:10px;flex-wrap:wrap"><span>Total <b>${fmt.money(total)}</b></span><span>Donated <b>${fmt.money(donated)}</b></span><span>Cost after donations <b>${fmt.money(total - donated)}</b></span>
        ${b.event.lastYear?.totalCost ? `<span class="small">Last year: ${fmt.money(b.event.lastYear.totalCost)}</span>` : ''}</div>
      ${owed.length ? `<div style="margin-top:8px"><b>Please pay:</b> ${owed.map(([w, a]) => `${esc(w)} ${fmt.money(a)}`).join(', ')}</div>` : ''}
      <form id="addEx" class="noprint" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:end">
        <div class="field"><label>Paid by</label><input name="who" required></div><div class="field"><label>Store</label><input name="vendor"></div>
        <div class="field"><label>Amount</label><input name="amount" type="number" step="0.01" required></div><button class="btn">Add expense</button></form>
      <div id="receiptView"></div></div>

    <div class="card noprint"><h3>Save as next year's playbook</h3>
      <p class="small">Copies this event's tasks (with any edits you made), shift sizes, shopping quantities, today's results and your lessons into a new playbook version. Next year: create an event from it and assign people.</p>
      <button class="btn primary" id="exportPb">Save playbook for next year</button> <span id="exportOut" class="small"></span></div>`;
  document.getElementById('resForm').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const lessons = f.lessons; delete f.lessons;
    await act(() => api('PUT', `/admin/events/${A.eid}/results`, { fields: f, lessons }), 'Results saved');
    await load();
  };
  document.getElementById('addEx').onsubmit = async e => { e.preventDefault(); await act(() => api('POST', `/admin/events/${A.eid}/expenses`, Object.fromEntries(new FormData(e.target))), 'Added'); await load(); };
  el.querySelectorAll('[data-xflag]').forEach(c => c.onchange = async () => { const [x, k] = c.dataset.xflag.split(':'); await act(() => api('PUT', `/admin/events/${A.eid}/expenses/${x}`, { [k]: c.checked })); await load(); });
  el.querySelectorAll('[data-xdel]').forEach(bt => bt.onclick = async () => { if (!confirm('Delete this expense?')) return; await act(() => api('DELETE', `/admin/events/${A.eid}/expenses/${bt.dataset.xdel}`)); await load(); });
  el.querySelectorAll('[data-receipt]').forEach(bt => bt.onclick = async () => {
    const r2 = await act(() => api('GET', `/admin/events/${A.eid}/expenses/${bt.dataset.receipt}/receipt`));
    document.getElementById('receiptView').innerHTML = r2.dataUrl.startsWith('data:image') ? `<img src="${r2.dataUrl}" style="max-width:100%;margin-top:12px;border-radius:8px">` : `<a href="${r2.dataUrl}" download="receipt">Download receipt</a>`;
  });
  document.getElementById('exportPb').onclick = async () => {
    const pb = await act(() => api('POST', `/admin/events/${A.eid}/playbook`), 'Playbook saved');
    document.getElementById('exportOut').textContent = `Saved "${pb.name}" version ${pb.version}. Find it under All events & playbooks.`;
  };
}

/* ---------------------------------------------------------------- message log */
function pMessages(el) {
  const sel = A.msgFilter || '';
  const list = A.msgs.filter(m => !sel || m.pid === sel);
  const people = Object.values(A.b.people).sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = `<div class="page-h"><h2>Message log</h2><span class="muted">${A.msgs.length} messages</span></div>
    <p class="lead">Every text and email in and out, newest first.</p>
    <div class="filters"><select id="mf" style="max-width:280px"><option value="">Everyone</option>${people.map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
    <div class="card"><table><tr><th style="width:150px">When</th><th>Who</th><th>How</th><th>Message</th></tr>
    ${list.map(m => `<tr><td class="small">${fmt.dt(m.at, tz())}</td><td>${m.dir === 'in' ? 'from ' : 'to '}${esc(m.pid ? P(m.pid).name : (m.from || m.to || ''))}<div class="small">${esc(m.kind || '')}</div></td>
      <td>${m.channel}${m.error ? `<div class="small" style="color:var(--red)">${esc(m.error)}</div>` : ''}</td>
      <td>${m.subject ? `<b>${esc(m.subject)}</b><details><summary class="small">Show email</summary><pre class="mail">${linkify(m.body)}</pre></details>` : linkify(m.body)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing sent yet.</td></tr>'}
    </table></div>`;
  document.getElementById('mf').onchange = e => { A.msgFilter = e.target.value; render(); };
}

/* ---------------------------------------------------------------- dev: phone & email simulator */
function pDev(el) {
  const people = Object.values(A.b.people).sort((a, b) => a.name.localeCompare(b.name));
  const phones = people.filter(p => p.phone);
  if (!A.phonePid) A.phonePid = (phones.find(p => p.name.startsWith('Kent')) || phones[0])?.id || 'other';
  if (!A.mailPid) A.mailPid = A.phonePid;
  const pp = A.b.people[A.phonePid];
  const number = A.phonePid === 'other' ? (A.otherNumber || '+15045550199') : pp?.phone;
  const thread = A.msgs.filter(m => m.channel === 'sms' && ((m.pid && m.pid === A.phonePid) || m.to === number || m.from === number)).slice().reverse();
  const mails = A.msgs.filter(m => m.channel === 'email' && m.pid === A.mailPid);
  el.innerHTML = `<div class="page-h"><h2>Phone & email simulator</h2></div>
    <p class="lead">Local testing only. The left phone shows the texts a person received; type a reply as if you were them - it goes through the real inbound path (SNS -> Lambda). Emails on the right; their links open the person's own page.</p>
    <div class="card" style="margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <b>Time</b> <input type="datetime-local" id="clockAt" style="width:auto" value="${new Date(nowIso()).toLocaleString('sv-SE', { timeZone: tz() }).slice(0, 16).replace(' ', 'T')}">
      <button class="btn" id="clockSet">Set time (${esc(tz())})</button>
      <button class="btn" id="clockReal">Back to real time</button>
      <span class="small">Moving time only changes what the Overview asks you to send - nothing goes out by itself.</span></div>
    <div class="grid" style="grid-template-columns:minmax(300px,380px) 1fr">
      <div><div class="field" style="margin-bottom:8px"><label>Phone of</label><select id="phonePick">${phones.map(p => `<option value="${p.id}" ${p.id === A.phonePid ? 'selected' : ''}>${esc(p.name)} ${esc(p.phoneDisplay)}${p.mobile === false ? ' (landline)' : ''}</option>`).join('')}<option value="other" ${A.phonePid === 'other' ? 'selected' : ''}>Someone not in the system...</option></select></div>
        ${A.phonePid === 'other' ? `<input id="otherNum" value="${esc(number)}" style="margin-bottom:8px">` : ''}
        ${smsOn() ? '' : '<div class="warnbox" style="margin-bottom:8px">Texts are off for this event (Contacts page) - the system only sends email.</div>'}
        ${pp?.mobile === false ? '<div class="warnbox" style="margin-bottom:8px">Landline - the system never texts this number; you get a "please call" alert instead.</div>' : ''}
        <div class="thread" id="thread">${thread.map(m => `<div class="b ${m.dir === 'in' ? 'out' : 'in'}">${linkify(m.body)}<span class="ts">${fmt.dt(m.at, tz())}</span></div>`).join('') || '<div class="small" style="margin:auto;text-align:center">No texts yet.<br>Send a task from the Overview to see it here.</div>'}</div>
        <form id="smsForm" style="display:flex;gap:6px;margin-top:8px"><input name="body" placeholder="Reply as this person..." autocomplete="off"><button class="btn primary">Send</button></form>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${['1', '2', 'HELP', 'STOP'].map(k => `<button class="btn sm" data-q="${esc(k)}">${esc(k)}</button>`).join('')}</div>
      </div>
      <div><div class="field" style="margin-bottom:8px"><label>Inbox of</label><select id="mailPick">${people.filter(p => p.email).map(p => `<option value="${p.id}" ${p.id === A.mailPid ? 'selected' : ''}>${esc(p.name)} - ${esc(p.email)}</option>`).join('')}</select></div>
        <div class="card" style="padding:0">${mails.map((m, i) => `<details ${i === 0 ? 'open' : ''} style="border-top:1px solid var(--line);padding:10px 14px"><summary><b>${esc(m.subject)}</b> <span class="small">${fmt.dt(m.at, tz())}</span></summary><pre class="mail" style="margin-top:8px">${linkify(m.body)}</pre></details>`).join('') || '<div class="muted" style="padding:14px">No emails yet.</div>'}</div>
        <p class="small">LocalStack's own record of every sent email: <a target="_blank" href="${esc(CFG.localstack || 'http://localhost:4666')}/_aws/ses">/_aws/ses</a> - texts: <a target="_blank" href="${esc(CFG.localstack || 'http://localhost:4666')}/_aws/sns/sms-messages">/_aws/sns/sms-messages</a></p>
      </div></div>`;
  const th = document.getElementById('thread'); th.scrollTop = th.scrollHeight;
  document.getElementById('phonePick').onchange = e => { A.phonePid = e.target.value; if (A.b.people[A.phonePid]?.email) A.mailPid = A.phonePid; render(); };
  document.getElementById('mailPick').onchange = e => { A.mailPid = e.target.value; render(); };
  const other = document.getElementById('otherNum'); if (other) other.onchange = () => { A.otherNumber = other.value; render(); };
  const send = async body => {
    if (!body.trim()) return;
    const from = A.phonePid === 'other' ? (document.getElementById('otherNum')?.value || number) : number;
    await act(() => api('POST', '/admin/dev/sms', { from, body }), 'Text sent - waiting for the reply...');
    for (const wait of [1500, 2500, 4000]) {
      await new Promise(r => setTimeout(r, wait));
      const before = A.msgs.length;
      await load();
      if (A.msgs.length >= before + 2) break;
    }
  };
  document.getElementById('smsForm').onsubmit = e => { e.preventDefault(); send(new FormData(e.target).get('body')); };
  el.querySelectorAll('[data-q]').forEach(b => b.onclick = () => send(b.dataset.q));
  document.getElementById('clockSet').onclick = () => moveClock('iso:' + zonedToIso(document.getElementById('clockAt').value, tz()));
  document.getElementById('clockReal').onclick = () => moveClock('real');
}

/* ---------------------------------------------------------------- boot */
(async () => {
  if (A.key && CFG.devMode) {
    try { A.clockSimulated = (await api('GET', '/admin/dev/clock')).simulated; } catch { /* login screen handles it */ }
  }
  if (!location.hash && A.key) {
    try {
      const evs = await api('GET', '/admin/events');
      const active = evs.filter(e => e.status === 'active').sort((a, b) => (a.date < b.date ? -1 : 1));
      if (active.length === 1) { location.hash = `#/e/${active[0].id}/overview`; return; }
    } catch { /* fall through */ }
  }
  route();
})();
