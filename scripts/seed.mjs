// Loads the GSC playbook, this year's people and the GSC 2026 event.
// Idempotent: re-running only fills in what is missing.
//   API=http://... ADMIN_KEY=... node scripts/seed.mjs
import { readFileSync, existsSync } from 'node:fs';

const API = process.env.API;
const KEY = process.env.ADMIN_KEY || 'local-admin';
if (!API) throw new Error('API is not set');

async function call(method, path, body) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', 'x-admin-key': KEY }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${data.error || ''}`);
  return data;
}

const playbook = JSON.parse(readFileSync(new URL('../playbooks/gsc-christmas-party.json', import.meta.url)));

// Phone numbers and emails are placeholders - edit them on the People page.
const PEOPLE = [
  { key: 'neo', name: 'Neo Chen', phone: '(504) 555-0100', email: 'neo@example.com', channels: ['sms', 'email'], notes: 'Coordinator' },
  { key: 'alan', name: 'Alan', phone: '(504) 555-0111', email: 'alan@example.com', channels: ['sms', 'email'], notes: 'Forwards to the Knights council' },
  { key: 'megan', name: 'Megan Riley Weebly', phone: '(504) 555-0122', email: 'megan@example.com', channels: ['email', 'sms'], notes: 'Daughters Regent' },
  { key: 'cat', name: 'Cathleen "Cat" Stuart', firstName: 'Cat', phone: '(504) 555-0133', email: 'cat@example.com', channels: ['sms', 'email'] },
  { key: 'kent', name: 'Kent Finger', phone: '(504) 555-0144', email: 'kent@example.com', channels: ['sms', 'email'], notes: 'Shopping + jambalaya' },
  { key: 'cj', name: 'CJ', email: 'cj@example.com', channels: ['email'], notes: 'Parish facilities' },
  { key: 'cathy', name: 'Cathy Lorio', phone: '(504) 555-0166', channels: ['sms'], notes: 'Santa gifts (Daughters)' },
  { key: 'gail', name: 'Gail Siciliano', phone: '(504) 555-0177', mobile: false, channels: [], notes: 'Landline only - call her. Gifts with her grandchildren.' },
  { key: 'rick', name: 'Rick Redmann', phone: '(504) 555-0188', channels: ['sms'], notes: 'Polaroid photos with Santa' },
];
// Real contact details stay out of git: scripts/people.local.json (gitignored)
// maps a person key to the fields that replace the placeholders above.
const LOCAL = new URL('./people.local.json', import.meta.url);
if (existsSync(LOCAL)) {
  const real = JSON.parse(readFileSync(LOCAL));
  for (const p of PEOPLE) Object.assign(p, real[p.key] || {});
}
const ROLES = {
  coordinator: ['neo'], knights_liaison: ['alan'], daughters_liaison: ['megan', 'cat'], purchasing: ['kent'],
  facilities: ['cj'], gifts: ['cathy', 'gail'], photos: ['rick'], santa: [], results: ['cat'],
};

const pbs = await call('GET', '/admin/playbooks');
if (!pbs.some(p => p.id === playbook.id)) {
  await call('POST', '/admin/playbooks', playbook);
  console.log(`  playbook  ${playbook.id} v${playbook.version}`);
}

const existing = await call('GET', '/admin/people');
const ids = {};
for (const p of PEOPLE) {
  const found = existing.find(e => e.name === p.name);
  ids[p.key] = found ? found.id : (await call('POST', '/admin/people', p)).id;
  if (!found) console.log(`  person    ${p.name}`);
}

const events = await call('GET', '/admin/events');
let ev = events.find(e => e.date === '2026-12-06' && e.playbookId === playbook.id);
if (!ev) {
  ev = await call('POST', '/admin/events', {
    playbookId: playbook.id, date: '2026-12-06', name: "God's Special Children Christmas Mass & Party 2026", guests: 130,
  });
  await call('PUT', `/admin/events/${ev.id}/assignments`, Object.fromEntries(Object.entries(ROLES).map(([r, ks]) => [r, ks.map(k => ids[k])])));
  console.log(`  event     ${ev.name} (${ev.id})`);
} else {
  console.log(`  event     already there (${ev.id})`);
}
