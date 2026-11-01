// Pure workflow engine: no AWS calls, no clock reads. Everything that decides
// "who gets told what, when" lives here so it can be unit-tested directly.
import { addDays, zonedToUtc, hoursBetween, daysBetween, localYmd } from './time.mjs';
import { render } from './template.mjs';
import { newId } from './ids.mjs';

export const OPEN = ['sent', 'reminded', 'call_needed', 'called', 'help'];

export const STATUS_LABEL = {
  scheduled: 'Scheduled', ready: 'Ready to send', todo: 'To do', sent: 'Sent - waiting', remind: 'Send a reminder',
  reminded: 'Reminder sent', call_needed: 'Call needed', called: 'Called', done: 'Done', help: 'Needs help',
};

/**
 * Channels we can actually reach this person on, in their preferred order.
 * Email is the default; texts only go out when the event's policy turns them on.
 */
export function channelsFor(p, policy = {}) {
  if (!p) return [];
  const pref = p.channels && p.channels.length ? p.channels : ['sms', 'email'];
  const out = [];
  for (const c of pref) {
    if (c === 'sms' && policy.sms && p.phone && p.mobile !== false && p.smsOptIn !== false) out.push('sms');
    if (c === 'email' && p.email) out.push('email');
  }
  return [...new Set(out)];
}

export const firstName = p => (p?.firstName || (p?.name || '').replace(/"[^"]*"\s*/, '').trim().split(/\s+/)[0] || '');

/** Build an event (plus its tasks, shifts, shopping list) from a playbook. */
export function instantiate(pb, input) {
  const tz = input.timezone || pb.defaults.timezone;
  const date = input.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
  const assignments = input.assignments || {};
  const event = {
    id: input.id || newId('evt'),
    playbookId: pb.id, playbookVersion: pb.version,
    name: input.name || `${pb.name} ${date.slice(0, 4)}`,
    baseName: pb.name,
    date, timezone: tz,
    venue: input.venue || pb.defaults.venue,
    guests: Number(input.guests || pb.defaults.guests),
    organization: input.organization || pb.defaults.organization,
    policy: { ...pb.policy },
    phases: pb.phases, roles: pb.roles,
    assignments,
    resultsForm: pb.resultsForm || [],
    lastYear: pb.lastYear || null,
    status: 'active',
    tokens: {},
    createdAt: input.now || new Date().toISOString(),
  };
  const ctx = { guests: event.guests, eventDate: date, year: date.slice(0, 4), venue: event.venue };
  const tasks = pb.tasks.map(t => {
    const pids = [...new Set(t.roles.flatMap(r => assignments[r] || []))];
    return {
      id: t.key, key: t.key, phase: t.phase, roles: t.roles, kind: t.kind,
      title: render(t.title, ctx),
      sendAt: zonedToUtc(addDays(date, t.send), t.sendTime || pb.defaults.sendTime, tz),
      dueAt: zonedToUtc(addDays(date, t.due), '21:00', tz),
      sendTime: t.sendTime || null,
      sms: t.sms || '', email: t.email || null,
      checklist: (t.checklist || []).map((text, i) => ({ id: `c${i + 1}`, text })),
      shoppingStores: t.shoppingStores || [],
      assignees: Object.fromEntries(pids.map(pid => [pid, { status: 'scheduled' }])),
      log: [],
    };
  });
  const shifts = (pb.shifts || []).map(s => ({
    id: s.key, key: s.key, name: s.name, need: s.need,
    day: s.day, start: s.start, end: s.end,
    startAt: zonedToUtc(addDays(date, s.day), s.start, tz),
    endAt: zonedToUtc(addDays(date, s.day), s.end, tz),
    signups: [],
  }));
  const shopping = (pb.shopping || []).map((it, i) => ({
    id: `i${String(i + 1).padStart(3, '0')}`, store: it.store, name: it.name,
    qty: it.qty, lastQty: it.lastQty, note: it.note || '', bought: false,
  }));
  return { event, tasks, shifts, shopping };
}

/** Recompute task assignees after the role -> people mapping changed. */
export function reassign(task, assignments) {
  const want = new Set(task.roles.flatMap(r => assignments[r] || []));
  const next = {};
  for (const pid of want) next[pid] = task.assignees[pid] || { status: 'scheduled' };
  task.assignees = next;
  return task;
}

const log = (task, at, text, kind = 'info') => { task.log = [...(task.log || []), { at, text, kind }].slice(-60); };

/**
 * Where one assignee stands right now. Nothing goes out by itself: the
 * coordinator presses Send. Time only changes what the dashboard asks for:
 *   ready        - its time has come, waiting for the coordinator to send it
 *   remind       - no reply `remindAfterHours` after sending: suggest a reminder
 *   call_needed  - no reply `escalateAfterHours` after sending (and at least
 *                  the remaining hours after a reminder), or no way to email them
 */
export function liveStatus(task, a, person, policy, now) {
  if (a.status === 'scheduled') {
    if (now < task.sendAt) return 'scheduled';
    if (task.kind === 'coordinator') return 'todo';
    return channelsFor(person, policy).length ? 'ready' : 'call_needed';
  }
  if (a.status === 'sent' || a.status === 'reminded') {
    const h = hoursBetween(a.sentAt, now);
    const afterReminder = a.status === 'reminded' ? hoursBetween(a.remindedAt, now) : Infinity;
    if (h >= policy.escalateAfterHours && afterReminder >= policy.escalateAfterHours - policy.remindAfterHours) return 'call_needed';
    if (a.status === 'sent' && h >= policy.remindAfterHours) return 'remind';
  }
  return a.status;
}

/** Copies of the tasks with every assignee's `status` replaced by its live status (stored one kept as `saved`). */
export function withLiveStatus({ event, tasks, people, now }) {
  return tasks.map(t => ({
    ...t,
    assignees: Object.fromEntries(Object.entries(t.assignees).map(([pid, a]) => [pid, { ...a, saved: a.status, status: liveStatus(t, a, people[pid], event.policy, now) }])),
  }));
}

/**
 * Record that the coordinator sent this task to `pid`. The first send starts
 * the reply clock; any later send is a reminder. Mutates and returns the task.
 */
export function markSent(task, pid, { now, name = pid, channels = [] }) {
  const a = task.assignees[pid];
  if (!a) throw new Error(`${pid} is not assigned to ${task.id}`);
  const how = channels.length ? ` (${channels.join(' + ')})` : '';
  if (a.status === 'scheduled') {
    Object.assign(a, { status: 'sent', sentAt: now, lastNotifiedAt: now });
    log(task, now, `Sent to ${name}${how}`, 'sent');
    return 'initial';
  }
  if (a.status === 'sent' || a.status === 'reminded') Object.assign(a, { status: 'reminded', remindedAt: now });
  a.lastNotifiedAt = now;
  log(task, now, `Reminder sent to ${name}${how}`, 'sent');
  return 'reminder';
}

/** Record an answer from (or about) one assignee. Mutates and returns the task. */
export function applyResponse(task, pid, status, { note = '', now, by = 'sms', name = pid } = {}) {
  const a = task.assignees[pid];
  if (!a) throw new Error(`${pid} is not assigned to ${task.id}`);
  a.status = status;
  a.respondedAt = now;
  if (note) a.note = note;
  const verb = { done: 'marked done', help: 'asked for help', called: 'was called by the coordinator', todo: 'reopened' }[status] || status;
  log(task, now, `${name} ${verb} (via ${by})${note ? `: "${note}"` : ''}`, status === 'help' ? 'help' : status === 'done' ? 'done' : 'info');
  return task;
}

/** Which open item does an SMS reply like "1" refer to? The most recent one. */
export function pickReplyTarget(pid, tasks, broadcasts, { tasksOnly = false } = {}) {
  const cands = [];
  for (const t of tasks) {
    const a = t.assignees?.[pid];
    if (a && OPEN.includes(a.status) && t.kind !== 'coordinator') cands.push({ type: 'task', item: t, at: a.lastNotifiedAt || a.sentAt || '' });
  }
  if (!tasksOnly) {
    for (const b of broadcasts) if (b.to.includes(pid) && !b.acks[pid]) cands.push({ type: 'broadcast', item: b, at: b.sentAt });
  }
  // newest first; on a tie an announcement wins (it was just sent and asks for "1")
  cands.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.type === y.type ? 0 : x.type === 'broadcast' ? -1 : 1));
  return cands[0] || null;
}

/** Interpret an inbound text. */
export function parseSms(body) {
  const raw = String(body || '').trim();
  const up = raw.toUpperCase();
  if (/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT)$/.test(up)) return { type: 'stop' };
  if (/^(START|UNSTOP)$/.test(up)) return { type: 'start' };
  if (/^(HELP|INFO)$/.test(up)) return { type: 'helpinfo' };
  let m = up.match(/^(1|DONE|YES|Y|OKAY|OK|CONFIRMED|CONFIRM|GOT IT)(?=$|[\s.,!-])[\s.,!-]*/);
  if (m) return { type: 'done', note: raw.slice(m[0].length).trim() };
  m = up.match(/^(2|NEED HELP)(?=$|[\s.,!-])[\s.,:!-]*/);
  if (m) return { type: 'help', note: raw.slice(m[0].length).trim() };
  return { type: 'free', text: raw };
}

/** Turn a finished event back into a playbook for next year. */
export function playbookFromEvent({ event, tasks, shifts, shopping, results }, base) {
  const offset = iso => daysBetween(event.date, localYmd(iso, event.timezone));
  const expenses = results?.expenses || [];
  const total = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  return {
    ...base,
    version: (base.version || 1) + 1,
    defaults: { ...base.defaults, venue: event.venue, guests: Number(results?.fields?.party) || event.guests, timezone: event.timezone, organization: event.organization },
    policy: event.policy,
    roles: event.roles,
    tasks: tasks.map(t => {
      const orig = base.tasks.find(x => x.key === t.key) || {};
      return {
        key: t.key, phase: t.phase, roles: t.roles, kind: t.kind,
        send: offset(t.sendAt), due: offset(t.dueAt), ...(t.sendTime ? { sendTime: t.sendTime } : {}),
        title: orig.title || t.title, sms: t.sms, email: t.email,
        checklist: (t.checklist || []).map(c => c.text), shoppingStores: t.shoppingStores,
      };
    }),
    shifts: shifts.map(s => ({ key: s.key, name: s.name, day: s.day, start: s.start, end: s.end, need: s.need })),
    shopping: shopping.map(i => ({ store: i.store, name: i.name, lastQty: i.qty, qty: i.qty, note: i.note || '' })),
    resultsForm: (event.resultsForm || []).map(g => ({ ...g, fields: g.fields.map(f => ({ ...f, last: results?.fields?.[f.key] ?? '?' })) })),
    lastYear: {
      year: Number(event.date.slice(0, 4)),
      totalCost: Math.round(total * 100) / 100,
      donations: 0,
      notes: (results?.lessons || '').split('\n').map(s => s.trim()).filter(Boolean),
    },
  };
}
