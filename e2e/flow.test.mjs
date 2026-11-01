// End-to-end test against the stack deployed in LocalStack.
// Uses its own people (555-9xxx numbers) and its own event, drives the dev
// clock through the whole timeline, presses Send like the coordinator does
// (nothing goes out by itself) and checks every channel for real:
// SNS for texts, SES for email, SNS->Lambda for replies, S3 for receipts.
//   API=... LS=http://localhost:4666 node --test e2e/flow.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const API = process.env.API;
const LS = process.env.LS || 'http://localhost:4666';
const KEY = process.env.ADMIN_KEY || 'local-admin';
const RUN = Date.now().toString(36).slice(-4);

async function call(method, path, body, admin = true) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(admin ? { 'x-admin-key': KEY } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${d.error || ''}`);
  return d;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, ms = 25000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(700); }
  throw new Error(`Timed out waiting for ${what}`);
}

const num = n => `+1555900${String(n).padStart(4, '0')}`.slice(0, 12);
const ppl = {};
let eid, tasks;
const T = key => tasks.find(t => t.key === key);
const state = async () => call('GET', `/admin/events/${eid}`);
const at = async iso => call('PUT', '/admin/dev/clock', { now: iso });
const send = (key, pids) => call('POST', `/admin/events/${eid}/tasks/${key}/send`, pids ? { pids } : {});
const alerts = async () => (await msgs()).filter(x => x.kind === 'alert');
const plusMin = (iso, m = 1) => new Date(Date.parse(iso) + m * 60e3).toISOString();
const plusH = (iso, h) => new Date(Date.parse(iso) + h * 36e5).toISOString();
const msgs = () => call('GET', `/admin/events/${eid}/messages`);
const text = (from, body) => call('POST', '/admin/dev/sms', { from, body });
const status = async (key, pid) => (await state()).tasks.find(t => t.key === key).assignees[pid].status;

before(async () => {
  assert.ok(API, 'API env var is required');
  const pbs = await call('GET', '/admin/playbooks');
  if (!pbs.some(p => p.id === 'gsc-christmas-party')) {
    const { readFileSync } = await import('node:fs');
    await call('POST', '/admin/playbooks', JSON.parse(readFileSync(new URL('../playbooks/gsc-christmas-party.json', import.meta.url))));
  }
  const mk = async (k, body) => { ppl[k] = await call('POST', '/admin/people', { ...body, name: `${body.name} ${RUN}` }); };
  await mk('coord', { name: 'E2E Coordinator', phone: num(1000 + Math.floor(Math.random() * 999)), email: `coord-${RUN}@example.com` });
  await mk('worker', { name: 'E2E Worker', phone: num(2000 + Math.floor(Math.random() * 999)), email: `worker-${RUN}@example.com` });
  await mk('landline', { name: 'E2E Landline', phone: num(3000 + Math.floor(Math.random() * 999)), mobile: false, channels: [] });
  await mk('mailonly', { name: 'E2E Mailonly', email: `mail-${RUN}@example.com`, channels: ['email'] });
  const ev = await call('POST', '/admin/events', { playbookId: 'gsc-christmas-party', date: '2026-12-06', name: `E2E ${RUN}` });
  eid = ev.id;
  assert.equal(ev.policy.sms, false, 'new events are email-only');
  await call('PUT', `/admin/events/${eid}`, { sms: true }); // most tests below exercise the optional SMS channel
  await call('PUT', '/admin/dev/clock', { now: '2026-10-16T12:00:00.000Z' });
  await call('PUT', `/admin/events/${eid}/assignments`, {
    coordinator: [ppl.coord.id], purchasing: [ppl.worker.id], knights_liaison: [ppl.worker.id], results: [ppl.worker.id],
    gifts: [ppl.landline.id], daughters_liaison: [ppl.mailonly.id], facilities: [ppl.mailonly.id], photos: [], santa: [],
  });
  tasks = (await state()).tasks;
});

after(async () => {
  await call('PUT', `/admin/events/${eid}`, { status: 'archived' }).catch(() => {});
  await call('PUT', '/admin/dev/clock', { now: null }).catch(() => {});
});

test('nothing goes out before its time', async () => {
  await at('2026-10-16T13:59:00.000Z');
  assert.equal(await status('confirm-team', ppl.coord.id), 'scheduled');
  assert.equal((await msgs()).length, 0);
});

test('coordinator tasks become to-dos; an unassigned role is only shown, not emailed', async () => {
  await at(plusMin(T('confirm-team').sendAt));
  assert.equal(await status('confirm-team', ppl.coord.id), 'todo');
  await at(plusMin(T('recruit-santa').sendAt));
  assert.deepEqual((await state()).tasks.find(t => t.key === 'recruit-santa').assignees, {});
  assert.equal((await alerts()).length, 0);
});

test('email-only person: ready until Send, reminder suggested at 48h, call at 72h - only the coordinator sends', async () => {
  const t = T('daughters-save-the-date');
  await at(plusMin(t.sendAt));
  assert.equal(await status(t.key, ppl.mailonly.id), 'ready');
  await at(plusH(t.sendAt, 30));
  assert.equal(await status(t.key, ppl.mailonly.id), 'ready', 'time alone sends nothing');
  assert.ok(!(await msgs()).some(x => x.taskId === t.key));

  const sentAt = plusH(t.sendAt, 30);
  assert.deepEqual(await send(t.key), { sent: 1, skipped: [] });
  assert.equal(await status(t.key, ppl.mailonly.id), 'sent');
  await at(plusH(sentAt, 48.1));
  assert.equal(await status(t.key, ppl.mailonly.id), 'remind');
  await send(t.key, [ppl.mailonly.id]);
  assert.equal(await status(t.key, ppl.mailonly.id), 'reminded');
  await at(plusH(sentAt, 72.2));
  assert.equal(await status(t.key, ppl.mailonly.id), 'call_needed');
  const m = await msgs();
  const mails = m.filter(x => x.pid === ppl.mailonly.id && x.channel === 'email' && x.taskId === t.key);
  assert.deepEqual(mails.map(x => x.kind).sort(), ['initial', 'reminder']);
  assert.match(mails.find(x => x.kind === 'initial').body, /Saturday, December 5, 2026 from 3:00 - 6:00 PM/);
  assert.equal((await alerts()).length, 0, 'the dashboard shows it; nobody is emailed about it');
  // LocalStack really received it through SES
  const ses = await (await fetch(`${LS}/_aws/ses`)).json();
  assert.ok(JSON.stringify(ses).includes(`mail-${RUN}@example.com`), 'SES has the email');
});

test('SMS: text goes out via SNS, reply "1" through SNS->Lambda marks it done', async () => {
  const t = T('knights-save-the-date');
  await at(plusMin(t.sendAt));
  await send(t.key);
  const out = (await msgs()).find(x => x.pid === ppl.worker.id && x.channel === 'sms' && x.taskId === t.key);
  assert.ok(out, 'sms logged');
  assert.match(out.body, /Reply 1 when done, 2 if you need help\.$/);
  assert.match(out.body, /p\.html\?t=/);
  const sns = await (await fetch(`${LS}/_aws/sns/sms-messages`)).json();
  assert.ok(JSON.stringify(sns).includes(ppl.worker.phone), 'SNS has the text');

  await text(ppl.worker.phone, '1');
  await waitFor(async () => (await status(t.key, ppl.worker.id)) === 'done', 'task done via sms');
  const reply = await waitFor(async () => (await msgs()).find(x => x.kind === 'reply' && x.to === ppl.worker.phone), 'thank-you reply');
  assert.match(reply.body, /Marked done: "Knights save-the-date/);
});

test('landline-only person is never texted; coordinator is asked to call', async () => {
  const t = T('santa-gifts');
  await at(plusMin(t.sendAt));
  assert.equal(await status(t.key, ppl.landline.id), 'call_needed');
  assert.deepEqual(await send(t.key), { sent: 0, skipped: [ppl.landline.name] });
  assert.ok(!(await msgs()).some(x => x.pid === ppl.landline.id && x.dir === 'out'));
  await call('POST', `/admin/events/${eid}/tasks/${t.key}/assignees/${ppl.landline.id}`, { status: 'called' });
  assert.equal(await status(t.key, ppl.landline.id), 'called');
});

test('"Send all" sends every ready task at once', async () => {
  const d = await state();
  const ready = d.tasks.filter(t => Object.values(t.assignees).some(a => a.status === 'ready'));
  assert.ok(ready.length >= 1, 'some tasks are waiting');
  const r = await call('POST', `/admin/events/${eid}/send`, { which: 'ready' });
  assert.ok(r.sent >= ready.length);
  assert.ok(!(await state()).tasks.some(t => Object.values(t.assignees).some(a => a.status === 'ready')));
  await assert.rejects(call('POST', `/admin/events/${eid}/send`, { which: 'all' }), /400/);
  await assert.rejects(send('confirm-team'), /400/);
});

test('reply "2 ..." asks for help on the latest task and alerts the coordinator', async () => {
  await at(plusMin(T('knights-help-request').sendAt));
  await send('knights-help-request');
  await text(ppl.worker.phone, '1');
  await waitFor(async () => (await status('knights-help-request', ppl.worker.id)) === 'done', 'help request done');
  await at(plusMin(T('inventory').sendAt));
  await send('inventory');
  await text(ppl.worker.phone, '2 only one propane tank is full');
  await waitFor(async () => (await status('inventory', ppl.worker.id)) === 'help', 'inventory help');
  const s = await state();
  assert.equal(s.tasks.find(t => t.key === 'inventory').assignees[ppl.worker.id].note, 'only one propane tank is full');
  await waitFor(async () => (await msgs()).some(x => x.kind === 'alert' && x.pid === ppl.coord.id && /needs help with "Check supply inventory/.test(x.body)), 'help alert');
});

test('personal link page: checklist and resolving a task', async () => {
  const s = await state();
  const tok = s.event.tokens[ppl.worker.id];
  assert.ok(tok);
  let v = await call('GET', `/p/${tok}`, null, false);
  assert.equal(v.me.first, 'E2E');
  const inv = v.tasks.find(t => t.id === 'inventory');
  assert.ok(inv.checklist.length > 3);
  const blob = JSON.stringify(v);
  assert.ok(blob.includes(ppl.coord.email), 'coordinator contact is shown on purpose');
  assert.ok(!blob.includes(ppl.mailonly.email) && !blob.includes(ppl.landline.phone), 'other participants\' contacts do not leak');
  await call('POST', `/p/${tok}/tasks/inventory/checks`, { itemId: inv.checklist[0].id, checked: true }, false);
  v = await call('POST', `/p/${tok}/tasks/inventory`, { status: 'done' }, false);
  assert.equal(v.tasks.find(t => t.id === 'inventory').status, 'done');
  const st = await state();
  assert.equal(st.tasks.find(t => t.key === 'inventory').assignees[ppl.worker.id].checks[inv.checklist[0].id], true);
  await assert.rejects(call('GET', '/p/not-a-token', null, false), /404/);
});

test('shopping list on the personal page', async () => {
  await at(plusMin(T('shop-sams').sendAt));
  await send('shop-sams');
  const tok = (await state()).event.tokens[ppl.worker.id];
  const v = await call('GET', `/p/${tok}`, null, false);
  assert.ok(v.shopping.length > 10 && v.shopping.every(i => i.store.startsWith("Sam's")));
  const buns = v.shopping.find(i => i.name === 'Hamburger buns');
  assert.equal(buns, undefined, 'Saturday pick-up list not shown yet');
  await call('POST', `/p/${tok}/shopping/${v.shopping[0].id}`, { bought: true }, false);
  const s = await state();
  assert.equal(s.shopping.find(i => i.id === v.shopping[0].id).boughtBy, ppl.worker.id);
  assert.equal(s.shopping.find(i => i.name.startsWith('Hormel chili')).qty, '0');
});

test('shopping note: set on add, edited later, shown on the personal page', async () => {
  const added = await call('POST', `/admin/events/${eid}/shopping`, { store: "Sam's - Dry Goods", name: 'Foil pans', qty: '4', note: 'Deep ones' });
  assert.equal(added.note, 'Deep ones');
  await call('PUT', `/admin/events/${eid}/shopping/${added.id}`, { note: 'Deep ones only' });
  const tok = (await state()).event.tokens[ppl.worker.id];
  const v = await call('GET', `/p/${tok}`, null, false);
  assert.equal(v.shopping.find(i => i.id === added.id).note, 'Deep ones only');
});

test('announcement: sent when the coordinator presses Send, confirmation by text', async () => {
  const bc = await call('POST', `/admin/events/${eid}/broadcasts`, { text: 'Set-up moves to 2:30 PM.', pids: [ppl.worker.id, ppl.landline.id] });
  const sms = await waitFor(async () => (await msgs()).find(x => x.broadcastId === bc.id && x.channel === 'sms'), 'broadcast sms');
  assert.match(sms.body, /Set-up moves to 2:30 PM\. Reply 1 to confirm/);
  await text(ppl.worker.phone, 'yes');
  await waitFor(async () => (await state()).broadcasts.find(b => b.id === bc.id).acks[ppl.worker.id], 'ack via sms');
  const b = (await state()).broadcasts.find(x => x.id === bc.id);
  assert.deepEqual(Object.keys(b.acks), [ppl.worker.id], 'the landline still has to be called - the dashboard lists them after 24h');
});

test('volunteer shifts: coordinator picks people from the contact list', async () => {
  const vol = await call('POST', '/admin/people', { name: `E2E Volunteer ${RUN}`, phone: num(4000 + Math.floor(Math.random() * 999)) });
  await call('POST', `/admin/events/${eid}/shifts/cook/signups`, { pid: vol.id });
  await call('POST', `/admin/events/${eid}/shifts/cook/signups`, { pid: vol.id });
  await assert.rejects(call('POST', `/admin/events/${eid}/shifts/cook/signups`, { pid: 'p_nobody' }), /400/);
  await assert.rejects(call('POST', `/admin/events/${eid}/shifts/cook/signups`, { name: 'Walk In' }), /400/);
  await assert.rejects(call('GET', `/public/events/${eid}/signup`, null, false), /404/);
  let cook = (await state()).shifts.find(s => s.id === 'cook');
  assert.deepEqual(cook.signups.map(x => x.pid), [vol.id], 'added once, by contact id');
  const tok = (await state()).event.tokens[ppl.worker.id];
  await call('POST', `/admin/events/${eid}/shifts/setup/signups`, { pid: ppl.worker.id });
  const v = await call('GET', `/p/${tok}`, null, false);
  assert.deepEqual(v.shifts.map(s => s.id), ['setup'], 'personal page lists only their own shifts');
  await call('DELETE', `/admin/events/${eid}/shifts/cook/signups/${cook.signups[0].id}`);
  cook = (await state()).shifts.find(s => s.id === 'cook');
  assert.equal(cook.signups.length, 0);
});

test('a text from an unknown number goes to the coordinator, no sign-up', async () => {
  await text('+15045558888', 'COOK Bill Jones');
  const reply = await waitFor(async () => (await msgs()).find(x => x.kind === 'reply' && x.to === '+15045558888'), 'reply');
  assert.doesNotMatch(reply.body, /signed up/);
  assert.ok((await msgs()).some(x => x.kind === 'alert' && /unknown number/.test(x.body)));
  assert.ok((await state()).shifts.every(s => !s.signups.some(x => !x.pid)));
});

test('results form and receipts with a photo', async () => {
  await at(plusMin(T('results').sendAt));
  await send('results');
  const tok = (await state()).event.tokens[ppl.worker.id];
  let v = await call('GET', `/p/${tok}`, null, false);
  assert.ok(v.resultsForm);
  const fields = Object.fromEntries(v.resultsForm.flatMap(g => g.fields).map(f => [f.key, '1']));
  fields.party = '131';
  await call('POST', `/p/${tok}/results`, { fields, lessons: 'Rice: 10 lb was right\nOne more water case' }, false);
  await call('POST', `/p/${tok}/tasks/results`, { status: 'done' }, false);

  await at(plusMin(T('receipts').sendAt));
  await send('receipts');
  v = await call('GET', `/p/${tok}`, null, false);
  assert.equal(v.canUploadReceipts, true);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  v = await call('POST', `/p/${tok}/expenses`, { vendor: "Sam's", amount: '460.73', image: png }, false);
  assert.equal(v.expenses[0].amount, 460.73);
  assert.equal(v.expenses[0].hasReceipt, true);
  const s = await state();
  const r = await call('GET', `/admin/events/${eid}/expenses/${s.results.expenses[0].id}/receipt`);
  assert.equal(r.dataUrl, png);
  assert.equal(s.results.fields.party, '131');
});

test('with texts off (the default) everything goes by email only', async () => {
  await call('PUT', `/admin/events/${eid}`, { sms: false });
  const now = (await state()).now;
  const t = await call('POST', `/admin/events/${eid}/tasks`, { title: 'Email-only check', phase: 'Wrap-up', roles: ['purchasing'], sendAt: plusH(now, -1), dueAt: plusH(now, 24) });
  await send(t.id);
  await waitFor(async () => (await msgs()).some(x => x.taskId === t.id && x.channel === 'email'), 'task email');
  const bc = await call('POST', `/admin/events/${eid}/broadcasts`, { text: 'Email only now.', pids: [ppl.worker.id] });
  const mail = await waitFor(async () => (await msgs()).find(x => x.broadcastId === bc.id && x.channel === 'email'), 'broadcast email');
  assert.doesNotMatch(mail.body, /reply 1/);
  const m = await msgs();
  assert.ok(!m.some(x => (x.taskId === t.id || x.broadcastId === bc.id) && x.channel === 'sms'), 'no texts');
  assert.match((await state()).tasks.find(x => x.id === t.id).log[0].text, /\(email\)/);
  await call('DELETE', `/admin/events/${eid}/tasks/${t.id}`);
  await call('PUT', `/admin/events/${eid}`, { sms: true });
});

test('roles and tasks can be added, edited and deleted', async () => {
  let ev = await call('POST', `/admin/events/${eid}/roles`, { name: 'Music', description: 'Choir and sound' });
  const music = ev.roles.find(r => r.name === 'Music');
  assert.equal(music.key, 'music');
  ev = await call('PUT', `/admin/events/${eid}/roles/music`, { name: 'Music & Choir' });
  assert.equal(ev.roles.find(r => r.key === 'music').name, 'Music & Choir');
  await call('PUT', `/admin/events/${eid}/assignments`, { ...ev.assignments, music: [ppl.worker.id] });
  await assert.rejects(call('DELETE', `/admin/events/${eid}/roles/coordinator`), /400/);

  const now = (await state()).now;
  const t = await call('POST', `/admin/events/${eid}/tasks`, {
    title: 'Book the choir', phase: 'Prepare', roles: ['music'], checklist: ['Call the choir director', ''],
    shoppingStores: ["Sam's - Dry Goods", ' ', "Sam's - Dry Goods"], sendAt: plusH(now, -1), dueAt: plusH(now, 48),
  });
  assert.deepEqual(t.checklist, [{ id: 'c1', text: 'Call the choir director' }]);
  assert.deepEqual(t.shoppingStores, ["Sam's - Dry Goods"]);
  assert.equal((await state()).tasks.find(x => x.id === t.id).assignees[ppl.worker.id].status, 'ready', 'a past-due new task waits for Send');
  assert.ok(!(await msgs()).some(x => x.taskId === t.id));
  await assert.rejects(call('POST', `/admin/events/${eid}/tasks`, { title: 'x', phase: 'Prepare', roles: ['nope'], sendAt: now, dueAt: now }), /400/);
  await assert.rejects(call('DELETE', `/admin/events/${eid}/roles/music`), /409/);

  const due = plusH(now, 72);
  const ed = await call('PUT', `/admin/events/${eid}/tasks/${t.id}`, { dueAt: due, phase: 'Event', roles: ['music', 'coordinator'], checklist: ['Call the choir director', 'Send the song list'] });
  assert.equal(ed.dueAt, due);
  assert.equal(ed.phase, 'Event');
  assert.deepEqual(Object.keys(ed.assignees).sort(), [ppl.coord.id, ppl.worker.id].sort());
  assert.deepEqual(ed.checklist.map(c => c.id), ['c1', 'c2'], 'unchanged items keep their id');
  assert.deepEqual(ed.shoppingStores, ["Sam's - Dry Goods"], 'an edit without shoppingStores keeps them');
  assert.deepEqual((await call('PUT', `/admin/events/${eid}/tasks/${t.id}`, { shoppingStores: ['Dorignac\'s'] })).shoppingStores, ["Dorignac's"]);
  await assert.rejects(call('PUT', `/admin/events/${eid}/tasks/${t.id}`, { sendAt: plusH(due, 1) }), /400/);

  await call('DELETE', `/admin/events/${eid}/tasks/${t.id}`);
  assert.ok(!(await state()).tasks.some(x => x.id === t.id));
  ev = await call('DELETE', `/admin/events/${eid}/roles/music`);
  assert.ok(!ev.roles.some(r => r.key === 'music') && !ev.assignments.music);
  await call('POST', `/admin/events/${eid}/roles`, { name: 'Ushers' });
});

test('save as next year\'s playbook', async () => {
  const before = Math.max(...(await call('GET', '/admin/playbooks')).filter(p => p.id === 'gsc-christmas-party').map(p => p.version));
  const pb = await call('POST', `/admin/events/${eid}/playbook`);
  assert.equal(pb.version, before + 1, 'playbook version goes up by exactly one');
  assert.equal(pb.defaults.guests, 131);
  assert.equal(pb.lastYear.totalCost, 460.73);
  assert.deepEqual(pb.lastYear.notes, ['Rice: 10 lb was right', 'One more water case']);
  assert.equal(pb.tasks.find(t => t.key === 'knights-save-the-date').send, -30);
  assert.ok(pb.roles.some(r => r.name === 'Ushers'), 'added roles carry into next year');
  assert.equal(pb.shopping.find(i => i.name === 'Foil pans').note, 'Deep ones only', 'shopping notes carry into next year');
});

test('admin endpoints reject a wrong key', async () => {
  const r = await fetch(`${API}/admin/events`, { headers: { 'x-admin-key': 'nope' } });
  assert.equal(r.status, 401);
});
