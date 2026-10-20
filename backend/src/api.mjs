// HTTP API (API Gateway HTTP API, payload v2) - one Lambda, a small router.
//   /admin/*   coordinator dashboard, header x-admin-key
//   /p/{token} participant magic links (no login)
import { timingSafeEqual } from 'node:crypto';
import * as S from './lib/service.mjs';
import * as db from './lib/store.mjs';
import { K } from './lib/store.mjs';
import { HttpError } from './lib/service.mjs';
import * as aws from './lib/aws.mjs';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-admin-key',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
};
const json = (status, body) => ({ statusCode: status, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify(body) });

function isAdmin(headers) {
  const want = Buffer.from(process.env.ADMIN_KEY || '');
  const got = Buffer.from(headers['x-admin-key'] || '');
  return want.length > 0 && want.length === got.length && timingSafeEqual(want, got);
}

const routes = [];
const route = (method, pattern, admin, fn) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/\{(\w+)\}/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, admin, fn });
};

/* ---- admin: people & playbooks ---- */
route('GET', '/admin/people', true, async () => Object.values(await S.people()).sort((a, b) => a.name.localeCompare(b.name)));
route('POST', '/admin/people', true, async ({ body }) => S.savePerson(body));
route('PUT', '/admin/people/{pid}', true, async ({ p, body }) => S.savePerson(body, p.pid));
route('DELETE', '/admin/people/{pid}', true, async ({ p }) => { await db.del(...K.person(p.pid)); return { ok: true }; });
route('GET', '/admin/playbooks', true, async () => db.listPlaybooks());
route('POST', '/admin/playbooks', true, async ({ body }) => {
  if (!body?.id || !body?.tasks) throw new HttpError(400, 'Not a playbook');
  const latest = await db.latestPlaybook(body.id);
  return db.savePlaybook({ ...body, version: latest ? latest.version + 1 : body.version || 1 });
});

/* ---- admin: events ---- */
route('GET', '/admin/events', true, async () => db.listEvents());
route('POST', '/admin/events', true, async ({ body }) => S.createEvent(body));
route('GET', '/admin/events/{eid}', true, async ({ p }) => S.dashboard(p.eid));
route('PUT', '/admin/events/{eid}', true, async ({ p, body }) => S.updateEvent(p.eid, body));
route('PUT', '/admin/events/{eid}/assignments', true, async ({ p, body }) => S.setAssignments(p.eid, body));
route('GET', '/admin/events/{eid}/messages', true, async ({ p }) => db.listMessages(p.eid));
route('POST', '/admin/events/{eid}/playbook', true, async ({ p }) => S.exportPlaybook(p.eid));

route('POST', '/admin/events/{eid}/tasks', true, async ({ p, body }) => S.createTask(p.eid, body));
route('PUT', '/admin/events/{eid}/tasks/{tid}', true, async ({ p, body }) => S.updateTask(p.eid, p.tid, body));
route('DELETE', '/admin/events/{eid}/tasks/{tid}', true, async ({ p }) => S.deleteTask(p.eid, p.tid));
route('POST', '/admin/events/{eid}/roles', true, async ({ p, body }) => S.addRole(p.eid, body));
route('PUT', '/admin/events/{eid}/roles/{key}', true, async ({ p, body }) => S.updateRole(p.eid, p.key, body));
route('DELETE', '/admin/events/{eid}/roles/{key}', true, async ({ p }) => S.deleteRole(p.eid, p.key));
route('GET', '/admin/events/{eid}/tasks/{tid}/preview', true, async ({ p, q }) => S.previewTask(p.eid, p.tid, q.pid));
route('POST', '/admin/events/{eid}/tasks/{tid}/assignees/{pid}', true, async ({ p, body }) => S.respond(p.eid, p.tid, p.pid, body.status, { note: body.note, by: 'coordinator' }));
route('POST', '/admin/events/{eid}/tasks/{tid}/send', true, async ({ p, body }) => S.sendTask(p.eid, p.tid, { pids: body.pids }));
route('POST', '/admin/events/{eid}/send', true, async ({ p, body }) => S.sendAll(p.eid, body.which));

route('POST', '/admin/events/{eid}/broadcasts', true, async ({ p, body }) => S.createBroadcast(p.eid, body));
route('POST', '/admin/events/{eid}/broadcasts/{bid}/acks/{pid}', true, async ({ p }) => S.ackBroadcast(p.eid, p.bid, p.pid, 'coordinator'));

route('PUT', '/admin/events/{eid}/shifts/{sid}', true, async ({ p, body }) => S.updateShift(p.eid, p.sid, body));
route('POST', '/admin/events/{eid}/shifts/{sid}/signups', true, async ({ p, body }) => S.addSignup(p.eid, p.sid, body.pid));
route('DELETE', '/admin/events/{eid}/shifts/{sid}/signups/{suid}', true, async ({ p }) => S.removeSignup(p.eid, p.sid, p.suid));

route('POST', '/admin/events/{eid}/shopping', true, async ({ p, body }) => S.addShop(p.eid, body));
route('PUT', '/admin/events/{eid}/shopping/{iid}', true, async ({ p, body }) => S.updateShop(p.eid, p.iid, body, 'coordinator'));
route('DELETE', '/admin/events/{eid}/shopping/{iid}', true, async ({ p }) => { await db.del(...K.shop(p.eid, p.iid)); return { ok: true }; });

route('PUT', '/admin/events/{eid}/results', true, async ({ p, body }) => S.saveResults(p.eid, body, 'coordinator'));
route('POST', '/admin/events/{eid}/expenses', true, async ({ p, body }) => S.addExpense(p.eid, body, 'coordinator'));
route('PUT', '/admin/events/{eid}/expenses/{xid}', true, async ({ p, body }) => S.updateExpense(p.eid, p.xid, body));
route('DELETE', '/admin/events/{eid}/expenses/{xid}', true, async ({ p }) => S.deleteExpense(p.eid, p.xid));
route('GET', '/admin/events/{eid}/expenses/{xid}/receipt', true, async ({ p }) => {
  const r = await db.get(...K.result(p.eid));
  const x = r?.expenses?.find(e => e.id === p.xid);
  if (!x?.receiptKey) throw new HttpError(404, 'No receipt');
  const f = await aws.getFile(x.receiptKey);
  return { dataUrl: `data:${f.contentType};base64,${f.body.toString('base64')}` };
});

/* ---- admin: dev tools (DEV_MODE only) ---- */
const dev = fn => async ctx => { if (process.env.DEV_MODE !== 'true') throw new HttpError(403, 'Dev mode is off'); return fn(ctx); };
route('GET', '/admin/dev/clock', true, async () => ({ now: await S.now(), simulated: process.env.DEV_MODE === 'true' && !!(await db.get(...K.clock()))?.now }));
route('PUT', '/admin/dev/clock', true, dev(async ({ body }) => S.setClock(body.now || null)));
route('POST', '/admin/dev/sms', true, dev(async ({ body }) => aws.publishInboundSms(body.from, body.body)));

/* ---- participant magic link ---- */
const who = async tok => S.resolveToken(tok);
route('GET', '/p/{tok}', false, async ({ p }) => S.participantView(p.tok));
route('POST', '/p/{tok}/tasks/{tid}', false, async ({ p, body }) => {
  const { eventId, pid } = await who(p.tok);
  if (!['done', 'help'].includes(body.status)) throw new HttpError(400, 'Bad status');
  await S.respond(eventId, p.tid, pid, body.status, { note: body.note, by: 'link' });
  return S.participantView(p.tok);
});
route('POST', '/p/{tok}/tasks/{tid}/checks', false, async ({ p, body }) => {
  const { eventId, pid } = await who(p.tok);
  await S.setCheck(eventId, p.tid, pid, body.itemId, body.checked);
  return { ok: true };
});
route('POST', '/p/{tok}/shopping/{iid}', false, async ({ p, body }) => {
  const { eventId, pid } = await who(p.tok);
  const view = await S.participantView(p.tok);
  if (!view.shopping.some(i => i.id === p.iid)) throw new HttpError(403, 'Not on your list');
  await S.updateShop(eventId, p.iid, { bought: !!body.bought }, pid);
  return { ok: true };
});
route('POST', '/p/{tok}/broadcasts/{bid}/ack', false, async ({ p }) => {
  const { eventId, pid } = await who(p.tok);
  await S.ackBroadcast(eventId, p.bid, pid, 'link');
  return S.participantView(p.tok);
});
route('POST', '/p/{tok}/results', false, async ({ p, body }) => {
  const { eventId, pid } = await who(p.tok);
  const view = await S.participantView(p.tok);
  if (!view.resultsForm) throw new HttpError(403, 'Not your form');
  await S.saveResults(eventId, { fields: body.fields, lessons: body.lessons }, pid);
  return S.participantView(p.tok);
});
route('POST', '/p/{tok}/expenses', false, async ({ p, body }) => {
  const { eventId, pid } = await who(p.tok);
  const view = await S.participantView(p.tok);
  if (!view.canUploadReceipts) throw new HttpError(403, 'Receipts are not open for you');
  const ppl = await S.people();
  await S.addExpense(eventId, { who: ppl[pid]?.name, vendor: body.vendor, amount: body.amount, note: body.note, image: body.image }, pid);
  return S.participantView(p.tok);
});

route('GET', '/health', false, async () => ({ ok: true, now: await S.now() }));

export async function handler(event) {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = (event.rawPath || event.path || '/').replace(/\/+$/, '') || '/';
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (!m) continue;
    if (r.admin && !isAdmin(headers)) return json(401, { error: 'Admin key required' });
    try {
      const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
      const body = raw ? JSON.parse(raw) : {};
      const p = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const out = await r.fn({ p, body, q: event.queryStringParameters || {}, headers });
      return json(200, out);
    } catch (e) {
      const status = e.status || (e instanceof SyntaxError ? 400 : e instanceof db.ConflictError ? 409 : /Not found/.test(e.message) ? 404 : 500);
      if (status === 500) console.error(e);
      return json(status, { error: e.message });
    }
  }
  return json(404, { error: `No route for ${method} ${path}` });
}
