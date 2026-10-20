// Application services: glue between storage, the pure engine and the channels.
import * as db from './store.mjs';
import { K } from './store.mjs';
import * as aws from './aws.mjs';
import {
  instantiate, reassign, withLiveStatus, markSent, applyResponse, pickReplyTarget, parseSms,
  channelsFor, firstName, playbookFromEvent,
} from './engine.mjs';
import { render } from './template.mjs';
import { newId, newToken, normalizePhone, displayPhone } from './ids.mjs';

const WEB = () => (process.env.WEB_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/* ---------- clock ---------- */
export async function now() {
  if (process.env.DEV_MODE === 'true') {
    const c = await db.get(...K.clock());
    if (c?.now) return c.now;
  }
  return new Date().toISOString();
}
export async function setClock(iso) {
  if (process.env.DEV_MODE !== 'true') throw new HttpError(403, 'Dev mode is off');
  if (iso && Number.isNaN(Date.parse(iso))) throw new HttpError(400, 'Invalid date');
  await db.put(...K.clock(), { now: iso ? new Date(iso).toISOString() : null });
  return { now: await now(), simulated: !!iso };
}

/* ---------- people ---------- */
const decorate = p => ({ ...p, phoneDisplay: displayPhone(p.phone) });
export async function people() {
  const all = await db.peopleById();
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, decorate(v)]));
}
export async function savePerson(input, pid) {
  if (!input.name) throw new HttpError(400, 'Name is required');
  const id = pid || newId('p');
  const cur = pid ? await db.get(...K.person(pid)) : null;
  if (pid && !cur) throw new HttpError(404, 'Person not found');
  const person = {
    ...(cur || {}), id, name: String(input.name).trim(),
    firstName: input.firstName || '',
    phone: normalizePhone(input.phone), email: (input.email || '').trim(),
    mobile: input.mobile !== false, smsOptIn: input.smsOptIn !== false,
    channels: Array.isArray(input.channels) && input.channels.length ? input.channels : ['sms', 'email'],
    notes: input.notes || '',
  };
  return decorate(await db.put(...K.person(id), person));
}

/* ---------- events ---------- */
export async function createEvent(input) {
  const pb = await db.latestPlaybook(input.playbookId);
  if (!pb) throw new HttpError(404, `Playbook ${input.playbookId} not found`);
  const { event, tasks, shifts, shopping } = instantiate(pb, { ...input, now: await now() });
  await db.put(...K.event(event.id), event, { expectVersion: 0 });
  await db.put(...K.eventIndex(event.id), { id: event.id, name: event.name, date: event.date, status: event.status, playbookId: pb.id });
  const writes = [
    ...tasks.map(t => () => db.put(...K.task(event.id, t.id), t)),
    ...shifts.map(s => () => db.put(...K.shift(event.id, s.id), s)),
    ...shopping.map(i => () => db.put(...K.shop(event.id, i.id), i)),
  ];
  for (let i = 0; i < writes.length; i += 10) await Promise.all(writes.slice(i, i + 10).map(f => f()));
  return event;
}

export async function bundle(eid) {
  const b = await db.loadBundle(eid);
  if (!b.event) throw new HttpError(404, 'Event not found');
  return b;
}

/** The event as the dashboard sees it: assignee statuses reflect the clock (ready, remind, call needed). */
export async function dashboard(eid) {
  const [b, ppl, at] = await Promise.all([bundle(eid), people(), now()]);
  return { ...b, tasks: withLiveStatus({ ...b, people: ppl, now: at }), people: ppl, now: at, devMode: process.env.DEV_MODE === 'true' };
}

export async function updateEvent(eid, patch) {
  const allowed = ['name', 'venue', 'guests', 'status'];
  const ev = await db.mutate(...K.event(eid), e => {
    for (const k of allowed) if (patch[k] !== undefined) e[k] = k === 'guests' ? Number(patch[k]) : patch[k];
    if (patch.sms !== undefined) e.policy = { ...e.policy, sms: !!patch.sms };
  });
  await db.put(...K.eventIndex(eid), { id: ev.id, name: ev.name, date: ev.date, status: ev.status, playbookId: ev.playbookId });
  return ev;
}

export async function setAssignments(eid, assignments) {
  const clean = Object.fromEntries(Object.entries(assignments || {}).map(([k, v]) => [k, [...new Set((v || []).filter(Boolean))]]));
  const ev = await db.mutate(...K.event(eid), e => { e.assignments = clean; });
  const b = await db.loadBundle(eid);
  for (const t of b.tasks) {
    const before = JSON.stringify(Object.keys(t.assignees).sort());
    reassign(t, clean);
    if (JSON.stringify(Object.keys(t.assignees).sort()) !== before) {
      await db.put(...K.task(eid, t.id), t, { expectVersion: t.rev });
    }
  }
  return ev;
}

/* ---------- links & message rendering ---------- */
export async function ensureToken(event, pid) {
  if (event.tokens?.[pid]) return event.tokens[pid];
  const tok = newToken();
  await db.put(...K.token(tok), { eventId: event.id, pid });
  const ev = await db.mutate(...K.event(event.id), e => { e.tokens = e.tokens || {}; if (!e.tokens[pid]) e.tokens[pid] = tok; });
  event.tokens = ev.tokens;
  return ev.tokens[pid];
}

export const personLink = tok => `${WEB()}/p.html?t=${tok}`;
export const dashboardLink = eid => `${WEB()}/index.html#/e/${eid}/overview`;

function coordinatorOf(event, ppl) { return ppl[(event.assignments?.coordinator || [])[0]] || null; }

export function ctxFor(event, person, ppl, token) {
  const c = coordinatorOf(event, ppl) || { name: 'The coordinator' };
  return {
    first: firstName(person), name: person?.name || '',
    eventName: event.baseName || event.name, venue: event.venue, guests: event.guests,
    org: event.organization, year: event.date.slice(0, 4), eventDate: event.date,
    coord: { name: c.name, first: firstName(c), phone: displayPhone(c.phone), email: c.email || '' },
    signature: ['Thank You!!!', c.name, event.organization, displayPhone(c.phone), c.email].filter(Boolean).join('\n'),
    link: token ? personLink(token) : WEB(),
  };
}

export function renderTaskMessage(task, event, ctx, mode = 'initial') {
  const pre = mode === 'reminder' ? 'Reminder: ' : '';
  const sms = `${pre}${render(task.sms || `Hi {{first}}, {{coord.first}} here. ${task.title}. Details: {{link}}`, ctx)} ${event.policy.smsFooter || ''}`.trim();
  const subject = pre + render(task.email?.subject || task.title, ctx);
  const body = render(task.email?.body || `{{first}},\n\n${task.title}\n\nDetails: {{link}}\n\n{{signature}}`, ctx);
  return { sms, subject, body };
}

async function deliver(event, person, msg, meta, at, channels = channelsFor(person, event.policy)) {
  const used = [];
  for (const ch of channels) {
    const rec = { id: newId('msg'), at, realAt: new Date().toISOString(), eventId: event.id, pid: person.id, dir: 'out', channel: ch, ...meta };
    try {
      if (ch === 'sms') { rec.to = person.phone; rec.body = msg.sms; rec.providerId = await aws.sendSms(person.phone, msg.sms); }
      if (ch === 'email') { rec.to = person.email; rec.subject = msg.subject; rec.body = msg.body; rec.providerId = await aws.sendEmail(person.email, msg.subject, msg.body); }
      used.push(ch);
    } catch (e) {
      rec.error = e.message;
      console.error('deliver failed', ch, person.id, e);
    }
    await db.logMessage(event.id, rec);
  }
  return used;
}

async function replySms(event, pid, to, body, at) {
  const rec = { id: newId('msg'), at, realAt: new Date().toISOString(), eventId: event?.id, pid, dir: 'out', channel: 'sms', to, body, kind: 'reply' };
  try { rec.providerId = await aws.sendSms(to, body); } catch (e) { rec.error = e.message; }
  await db.logMessage(event?.id, rec);
}

export async function alertCoordinator(event, ppl, text, at, meta = {}) {
  const c = coordinatorOf(event, ppl);
  if (!c) { await db.logMessage(event.id, { id: newId('msg'), at, eventId: event.id, dir: 'out', channel: 'none', kind: 'alert', body: text, error: 'No coordinator assigned' }); return; }
  await deliver(event, c, {
    sms: `[${event.baseName ? 'GSC' : 'Event'} alert] ${text}`,
    subject: `Action needed: ${text.slice(0, 70)}`,
    body: `${text}\n\nOpen the dashboard: ${dashboardLink(event.id)}`,
  }, { kind: 'alert', ...meta }, at);
}

/* ---------- sending (always started by the coordinator) ---------- */
/**
 * Email (and text, if on) task `tid` to `pids` - by default everyone whose
 * turn has come and who has not been sent it yet. A second send is a reminder.
 */
export async function sendTask(eid, tid, { pids } = {}) {
  const at = await now();
  const ppl = await people();
  const ev = await db.get(...K.event(eid));
  if (!ev) throw new HttpError(404, 'Event not found');
  const cur = await db.get(...K.task(eid, tid));
  if (!cur) throw new HttpError(404, 'Task not found');
  if (cur.kind === 'coordinator') throw new HttpError(400, 'This task is on your own to-do list - nothing to send');
  const want = pids?.length ? pids : Object.keys(cur.assignees).filter(pid => cur.assignees[pid].status === 'scheduled');
  const bad = want.filter(pid => !cur.assignees[pid]);
  if (bad.length) throw new HttpError(400, 'Not assigned to this task');
  const reach = want.filter(pid => channelsFor(ppl[pid], ev.policy).length);
  const skipped = want.filter(pid => !reach.includes(pid)).map(pid => ppl[pid]?.name || pid);
  if (!reach.length) return { sent: 0, skipped };
  const modes = {};
  const task = await db.mutate(...K.task(eid, tid), t => {
    for (const pid of reach) modes[pid] = markSent(t, pid, { now: at, name: ppl[pid].name, channels: channelsFor(ppl[pid], ev.policy) });
  });
  for (const pid of reach) {
    const tok = await ensureToken(ev, pid);
    await deliver(ev, ppl[pid], renderTaskMessage(task, ev, ctxFor(ev, ppl[pid], ppl, tok), modes[pid]), { kind: modes[pid], taskId: tid }, at);
  }
  return { sent: reach.length, skipped };
}

/** Send every task whose time has come ("ready") or that is waiting for a reminder ("remind"). */
export async function sendAll(eid, which) {
  if (!['ready', 'remind'].includes(which)) throw new HttpError(400, 'Send what? ready or remind');
  const d = await dashboard(eid);
  let sent = 0;
  const skipped = [];
  for (const t of d.tasks) {
    if (t.kind === 'coordinator') continue;
    const pids = Object.keys(t.assignees).filter(pid => t.assignees[pid].status === which);
    if (!pids.length) continue;
    const r = await sendTask(eid, t.id, { pids });
    sent += r.sent; skipped.push(...r.skipped);
  }
  return { sent, skipped };
}

/* ---------- responses ---------- */
export async function respond(eid, tid, pid, status, { note = '', by = 'link' } = {}) {
  if (!['done', 'help', 'called', 'todo'].includes(status)) throw new HttpError(400, 'Bad status');
  const at = await now();
  const ppl = await people();
  const task = await db.mutate(...K.task(eid, tid), t => applyResponse(t, pid, status, { note, now: at, by, name: ppl[pid]?.name || pid }));
  if (status === 'help') {
    const ev = (await db.get(...K.event(eid)));
    const p = ppl[pid];
    await alertCoordinator(ev, ppl, `${p?.name || pid} needs help with "${task.title}"${note ? `: "${note}"` : ''}. Call ${p?.phoneDisplay || ''}.`, at, { taskId: tid });
  }
  return task;
}

export async function setCheck(eid, tid, pid, cid, checked) {
  return db.mutate(...K.task(eid, tid), t => {
    const a = t.assignees[pid];
    if (!a) throw new HttpError(403, 'Not your task');
    a.checks = { ...(a.checks || {}), [cid]: !!checked };
  });
}

const TASK_KINDS = ['message', 'coordinator'];

/** Check the role/phase/checklist parts of a task form against the event. */
function taskFields(ev, input, task = {}) {
  const out = {};
  if (input.title !== undefined) {
    if (!String(input.title).trim()) throw new HttpError(400, 'Title is required');
    out.title = String(input.title).trim();
  }
  if (input.phase !== undefined) {
    if (!ev.phases.includes(input.phase)) throw new HttpError(400, `Unknown phase ${input.phase}`);
    out.phase = input.phase;
  }
  if (input.roles !== undefined) {
    const roles = [...new Set(input.roles || [])];
    if (!roles.length) throw new HttpError(400, 'Pick at least one role');
    const bad = roles.filter(r => !ev.roles.some(x => x.key === r));
    if (bad.length) throw new HttpError(400, `Unknown role ${bad.join(', ')}`);
    out.roles = roles;
  }
  if (input.checklist !== undefined) {
    // keep the ids of unchanged items so ticks people already made survive an edit
    const old = task.checklist || [];
    let n = old.reduce((m, c) => Math.max(m, Number(c.id.slice(1)) || 0), 0);
    out.checklist = (input.checklist || []).map(x => String(x).trim()).filter(Boolean)
      .map(text => old.find(c => c.text === text) || { id: `c${++n}`, text });
  }
  if (input.shoppingStores !== undefined) {
    out.shoppingStores = [...new Set((input.shoppingStores || []).map(x => String(x).trim()).filter(Boolean))];
  }
  for (const k of ['sendAt', 'dueAt']) if (input[k]) out[k] = new Date(input[k]).toISOString();
  if ((out.sendAt || task.sendAt) > (out.dueAt || task.dueAt)) throw new HttpError(400, 'Due time must be after the send time');
  return out;
}

export async function createTask(eid, input) {
  const ev = await db.get(...K.event(eid));
  if (!ev) throw new HttpError(404, 'Event not found');
  if (!input.sendAt || !input.dueAt) throw new HttpError(400, 'Send and due times are required');
  const kind = TASK_KINDS.includes(input.kind) ? input.kind : 'message';
  const f = taskFields(ev, { title: input.title ?? '', phase: input.phase, roles: input.roles, checklist: input.checklist || [], shoppingStores: input.shoppingStores || [], sendAt: input.sendAt, dueAt: input.dueAt });
  const id = newId('t');
  const task = reassign({
    id, key: id, kind, ...f, sendTime: null,
    sms: input.sms || '', email: input.emailSubject || input.emailBody ? { subject: input.emailSubject || '', body: input.emailBody || '' } : null,
    assignees: {}, log: [],
  }, ev.assignments || {});
  await db.put(...K.task(eid, id), task, { expectVersion: 0 });
  return task;
}

export async function updateTask(eid, tid, patch) {
  const ev = await db.get(...K.event(eid));
  const task = await db.mutate(...K.task(eid, tid), t => {
    const f = taskFields(ev, patch, t);
    Object.assign(t, f);
    if (f.roles) reassign(t, ev.assignments || {});
    if (patch.sms !== undefined) t.sms = patch.sms;
    if (patch.emailSubject !== undefined || patch.emailBody !== undefined) {
      t.email = { subject: patch.emailSubject ?? t.email?.subject ?? '', body: patch.emailBody ?? t.email?.body ?? '' };
    }
  });
  return task;
}

export async function deleteTask(eid, tid) {
  if (!(await db.get(...K.task(eid, tid)))) throw new HttpError(404, 'Task not found');
  await db.del(...K.task(eid, tid));
  return { ok: true };
}

/* ---------- roles ---------- */
const roleKey = (name, roles) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'role';
  let key = base;
  for (let i = 2; roles.some(r => r.key === key); i++) key = `${base}_${i}`;
  return key;
};

export async function addRole(eid, { name, description }) {
  if (!name?.trim()) throw new HttpError(400, 'Role name is required');
  return db.mutate(...K.event(eid), e => {
    e.roles = [...e.roles, { key: roleKey(name.trim(), e.roles), name: name.trim(), description: (description || '').trim() }];
  });
}

export async function updateRole(eid, key, { name, description }) {
  if (name !== undefined && !String(name).trim()) throw new HttpError(400, 'Role name is required');
  return db.mutate(...K.event(eid), e => {
    const r = e.roles.find(x => x.key === key);
    if (!r) throw new HttpError(404, 'Role not found');
    if (name !== undefined) r.name = String(name).trim();
    if (description !== undefined) r.description = String(description).trim();
  });
}

export async function deleteRole(eid, key) {
  if (key === 'coordinator') throw new HttpError(400, 'The coordinator role gets every alert and cannot be deleted');
  const b = await bundle(eid);
  if (!b.event.roles.some(r => r.key === key)) throw new HttpError(404, 'Role not found');
  const used = b.tasks.filter(t => t.roles.includes(key));
  if (used.length) throw new HttpError(409, `Still used by: ${used.map(t => t.title).join('; ')}. Move or delete these tasks first.`);
  return db.mutate(...K.event(eid), e => {
    e.roles = e.roles.filter(r => r.key !== key);
    if (e.assignments) delete e.assignments[key];
  });
}

export async function previewTask(eid, tid, pid) {
  const b = await bundle(eid);
  const task = b.tasks.find(t => t.id === tid);
  if (!task) throw new HttpError(404, 'Task not found');
  const ppl = await people();
  const person = ppl[pid] || ppl[Object.keys(task.assignees)[0]] || { id: 'x', name: 'Friend' };
  const tok = b.event.tokens?.[person.id] || 'preview';
  return renderTaskMessage(task, b.event, ctxFor(b.event, person, ppl, tok));
}

/* ---------- broadcasts ---------- */
export async function createBroadcast(eid, { text, pids }) {
  if (!text?.trim()) throw new HttpError(400, 'Message is empty');
  const to = [...new Set(pids || [])];
  if (!to.length) throw new HttpError(400, 'Nobody selected');
  const at = await now();
  const ppl = await people();
  const ev = await db.get(...K.event(eid));
  const bc = { id: newId('bc'), text: text.trim(), to, sentAt: at, acks: {} };
  await db.put(...K.bc(eid, bc.id), bc, { expectVersion: 0 });
  const c = coordinatorOf(ev, ppl);
  for (const pid of to) {
    const p = ppl[pid];
    if (!p) continue;
    const tok = await ensureToken(ev, pid);
    const ctx = ctxFor(ev, p, ppl, tok);
    await deliver(ev, p, {
      sms: `${ctx.eventName} update from ${firstName(c) || 'the coordinator'}: ${bc.text} Reply 1 to confirm you got this.`,
      subject: `Update: ${ctx.eventName}`,
      body: `${ctx.first},\n\n${bc.text}\n\nPlease tap here to confirm you got this: ${ctx.link}${ev.policy.sms ? '\n(or reply 1 to our text)' : ''}\n\n${ctx.signature}`,
    }, { kind: 'broadcast', broadcastId: bc.id }, at);
  }
  return bc;
}

export async function ackBroadcast(eid, bid, pid, by = 'link') {
  const at = await now();
  return db.mutate(...K.bc(eid, bid), b => {
    if (!b.to.includes(pid)) throw new HttpError(403, 'Not a recipient');
    if (!b.acks[pid]) b.acks[pid] = { at, by };
  });
}

/* ---------- shifts ---------- */
// Volunteers are always picked from the contact list by the coordinator.
export async function addSignup(eid, sid, pid) {
  if (!pid || !(await db.get(...K.person(pid)))) throw new HttpError(400, 'Pick someone from the contact list');
  const at = await now();
  return db.mutate(...K.shift(eid, sid), s => {
    if (s.signups.some(x => x.pid === pid)) return s;
    s.signups.push({ id: newId('su'), pid, at });
  });
}
export async function removeSignup(eid, sid, suid) {
  return db.mutate(...K.shift(eid, sid), s => { s.signups = s.signups.filter(x => x.id !== suid); });
}
export async function updateShift(eid, sid, patch) {
  return db.mutate(...K.shift(eid, sid), s => {
    for (const k of ['name', 'need']) if (patch[k] !== undefined) s[k] = k === 'need' ? Number(patch[k]) : patch[k];
  });
}

/* ---------- shopping ---------- */
export async function updateShop(eid, iid, patch, by) {
  const at = await now();
  return db.mutate(...K.shop(eid, iid), i => {
    for (const k of ['store', 'name', 'qty', 'lastQty', 'note']) if (patch[k] !== undefined) i[k] = patch[k];
    if (patch.bought !== undefined) { i.bought = !!patch.bought; i.boughtBy = patch.bought ? by : null; i.boughtAt = patch.bought ? at : null; }
  });
}
export async function addShop(eid, input) {
  const iid = newId('i');
  return db.put(...K.shop(eid, iid), { id: iid, store: input.store || 'Other', name: input.name || 'New item', qty: input.qty || '', lastQty: '', note: input.note || '', bought: false }, { expectVersion: 0 });
}

/* ---------- results & expenses ---------- */
async function mutateResult(eid, fn) {
  const cur = await db.get(...K.result(eid));
  if (!cur) {
    try { await db.put(...K.result(eid), { fields: {}, expenses: [], lessons: '' }, { expectVersion: 0 }); } catch (e) { if (!(e instanceof db.ConflictError)) throw e; }
  }
  return db.mutate(...K.result(eid), fn);
}
export async function saveResults(eid, { fields, lessons }, by) {
  const at = await now();
  return mutateResult(eid, r => {
    r.fields = { ...(r.fields || {}), ...(fields || {}) };
    if (lessons !== undefined) r.lessons = lessons;
    r.submittedBy = by; r.submittedAt = at;
  });
}
export async function addExpense(eid, { who, vendor, amount, note, image }, by) {
  const at = await now();
  const id = newId('x');
  let receiptKey = null;
  if (image) {
    const m = /^data:(image\/[a-z+]+|application\/pdf);base64,(.+)$/.exec(image);
    if (!m) throw new HttpError(400, 'Receipt must be an image');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 5 * 1024 * 1024) throw new HttpError(413, 'Receipt is too large');
    receiptKey = `receipts/${eid}/${id}.${m[1].split('/')[1].replace('jpeg', 'jpg')}`;
    await aws.putFile(receiptKey, buf, m[1]);
  }
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(amt) || amt < 0) throw new HttpError(400, 'Amount must be a number');
  return mutateResult(eid, r => {
    r.expenses = [...(r.expenses || []), { id, who: who || by, vendor: vendor || '', amount: amt, note: note || '', receiptKey, by, at, reimbursed: false }];
  });
}
export async function updateExpense(eid, xid, patch) {
  return mutateResult(eid, r => {
    r.expenses = r.expenses.map(x => (x.id === xid ? { ...x, ...['who', 'vendor', 'amount', 'note', 'reimbursed', 'donated'].reduce((o, k) => (patch[k] !== undefined ? { ...o, [k]: k === 'amount' ? Number(patch[k]) : patch[k] } : o), {}) } : x));
  });
}
export async function deleteExpense(eid, xid) {
  return mutateResult(eid, r => { r.expenses = r.expenses.filter(x => x.id !== xid); });
}

/* ---------- playbooks ---------- */
export async function exportPlaybook(eid) {
  const b = await bundle(eid);
  const base = await db.latestPlaybook(b.event.playbookId);
  const pb = playbookFromEvent(b, base);
  await db.savePlaybook(pb);
  return pb;
}

/* ---------- participant (magic link) ---------- */
export async function resolveToken(tok) {
  const t = await db.get(...K.token(tok));
  if (!t) throw new HttpError(404, 'This link is not valid any more. Please call the coordinator.');
  return t;
}

export async function participantView(tok) {
  const { eventId, pid } = await resolveToken(tok);
  const b = await bundle(eventId);
  const ppl = await people();
  const me = ppl[pid];
  const c = coordinatorOf(b.event, ppl);
  const mine = b.tasks.filter(t => t.assignees[pid] && t.assignees[pid].status !== 'scheduled' && t.kind !== 'coordinator');
  const stores = new Set(mine.flatMap(t => t.shoppingStores || []));
  return {
    me: { id: pid, name: me?.name, first: firstName(me) },
    event: { id: b.event.id, name: b.event.name, date: b.event.date, venue: b.event.venue, timezone: b.event.timezone },
    coordinator: c ? { name: c.name, phone: c.phoneDisplay, email: c.email } : null,
    tasks: mine.map(t => ({
      id: t.id, title: t.title, kind: t.kind, dueAt: t.dueAt, status: t.assignees[pid].status, note: t.assignees[pid].note || '',
      checklist: t.checklist, checks: t.assignees[pid].checks || {}, shoppingStores: t.shoppingStores,
      message: renderTaskMessage(t, b.event, ctxFor(b.event, me, ppl, tok)).body,
    })),
    shopping: b.shopping.filter(i => stores.has(i.store)),
    broadcasts: b.broadcasts.filter(x => x.to.includes(pid)).map(x => ({ id: x.id, text: x.text, sentAt: x.sentAt, acked: !!x.acks[pid] })),
    shifts: b.shifts.filter(s => s.signups.some(x => x.pid === pid)).map(s => ({ id: s.id, name: s.name, startAt: s.startAt, endAt: s.endAt })),
    resultsForm: mine.some(t => t.kind === 'results') ? b.event.resultsForm : null,
    results: mine.some(t => t.kind === 'results') ? (b.results?.fields || {}) : null,
    lessons: mine.some(t => t.kind === 'results') ? (b.results?.lessons || '') : null,
    expenses: (b.results?.expenses || []).filter(x => x.by === pid).map(({ id, vendor, amount, at, receiptKey }) => ({ id, vendor, amount, at, hasReceipt: !!receiptKey })),
    canUploadReceipts: mine.some(t => t.kind === 'receipts'),
  };
}

/* ---------- inbound SMS ---------- */
export async function handleInboundSms({ originationNumber, messageBody }) {
  const at = await now();
  const from = normalizePhone(originationNumber);
  const ppl = await people();
  const person = Object.values(ppl).find(p => p.phone === from) || null;

  const events = (await db.listEvents()).filter(e => e.status === 'active').sort((a, b) => (a.date < b.date ? -1 : 1));
  let b = null;
  for (const e of events) {
    const bb = await db.loadBundle(e.id);
    const involved = person && Object.values(bb.event.assignments || {}).some(list => list.includes(person.id));
    if (involved || !b) b = bb;
    if (involved) break;
  }
  if (!b) { console.warn('inbound sms with no active event', from); return { ignored: true }; }
  const ev = b.event;
  const pid = person?.id || null;
  await db.logMessage(ev.id, { id: newId('msg'), at, realAt: new Date().toISOString(), eventId: ev.id, pid, dir: 'in', channel: 'sms', from, body: messageBody });

  const c = coordinatorOf(ev, ppl);
  const cFirst = firstName(c) || 'The coordinator';
  const cmd = parseSms(messageBody);
  const reply = text => replySms(ev, pid, from, text, at);

  if (cmd.type === 'stop') {
    if (person) await db.mutate(...K.person(pid), p => { p.smsOptIn = false; });
    return { cmd };
  }
  if (cmd.type === 'start') {
    if (person) await db.mutate(...K.person(pid), p => { p.smsOptIn = true; });
    await reply(`You will get texts about ${ev.baseName || ev.name} again. Reply STOP to opt out.`);
    return { cmd };
  }
  if (cmd.type === 'helpinfo') {
    await reply(`${ev.organization}: texts about ${ev.baseName || ev.name}. Reply 1 = done, 2 = need help. Questions? Call ${cFirst} at ${displayPhone(c?.phone)}. Reply STOP to opt out.`);
    return { cmd };
  }
  if (!person) {
    await alertCoordinator(ev, ppl, `Text from an unknown number ${displayPhone(from)}: "${messageBody}"`, at);
    await reply(`Thanks for your message! ${cFirst} will get back to you.`);
    return { cmd, unknown: true };
  }
  if (cmd.type === 'done' || cmd.type === 'help') {
    const target = pickReplyTarget(pid, b.tasks, b.broadcasts, { tasksOnly: cmd.type === 'help' });
    if (!target) {
      if (cmd.type === 'help' || cmd.note) await alertCoordinator(ev, ppl, `${person.name} texted: "${messageBody}"`, at);
      await reply(cmd.type === 'help' ? `Got it - ${cFirst} will call you soon.` : `Thanks, ${firstName(person)}! There is nothing waiting for you right now.`);
      return { cmd, target: null };
    }
    if (target.type === 'broadcast') {
      await ackBroadcast(ev.id, target.item.id, pid, 'sms');
      await reply(`Thank you, ${firstName(person)}! Got your confirmation.`);
      return { cmd, broadcast: target.item.id };
    }
    await respond(ev.id, target.item.id, pid, cmd.type, { note: cmd.note, by: 'sms' });
    await reply(cmd.type === 'done'
      ? `Thank you, ${firstName(person)}! Marked done: "${target.item.title}".`
      : `Got it - ${cFirst} will call you soon about "${target.item.title}".`);
    return { cmd, task: target.item.id };
  }
  await alertCoordinator(ev, ppl, `${person.name} texted: "${messageBody}"`, at);
  await reply(`Thanks, ${firstName(person)}! ${cFirst} will get back to you. (Reply 1 = done, 2 = need help.)`);
  return { cmd };
}
