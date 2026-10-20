import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiate, liveStatus, withLiveStatus, markSent, applyResponse, pickReplyTarget, parseSms, channelsFor, reassign, playbookFromEvent } from '../src/lib/engine.mjs';
import { render, missingVars } from '../src/lib/template.mjs';
import { zonedToUtc, longDate, mdy, addDays } from '../src/lib/time.mjs';
import { normalizePhone, displayPhone } from '../src/lib/ids.mjs';

const pb = JSON.parse(readFileSync(new URL('../../playbooks/gsc-christmas-party.json', import.meta.url)));
const people = {
  neo: { id: 'neo', name: 'Neo Chen', phone: '+15045550100', email: 'neo@example.com' },
  kent: { id: 'kent', name: 'Kent Finger', phone: '+15045550144', email: 'kent@example.com' },
  gail: { id: 'gail', name: 'Gail Siciliano', phone: '+15045550177', mobile: false },
};
const assignments = { coordinator: ['neo'], purchasing: ['kent'], gifts: ['gail'] };
const make = () => instantiate(pb, { id: 'evt_test', date: '2026-12-06', assignments, now: '2026-10-16T00:00:00Z' });

test('time helpers', () => {
  assert.equal(zonedToUtc('2026-12-06', '09:00', 'America/Chicago'), '2026-12-06T15:00:00.000Z');
  assert.equal(zonedToUtc('2026-07-01', '09:00', 'America/Chicago'), '2026-07-01T14:00:00.000Z');
  assert.equal(longDate('2026-12-05'), 'Saturday, December 5, 2026');
  assert.equal(mdy('2026-12-06'), '12/6/2026');
  assert.equal(addDays('2026-12-06', -51), '2026-10-16');
});

test('phones', () => {
  assert.equal(normalizePhone('(504) 555-0144'), '+15045550144');
  assert.equal(displayPhone('+15045550144'), '(504) 555-0144');
});

test('instantiate builds tasks, shifts and shopping from the playbook', () => {
  const { event, tasks, shifts, shopping } = make();
  assert.equal(tasks.length, pb.tasks.length);
  assert.equal(shifts.length, 4);
  assert.ok(shopping.length > 30);
  const inv = tasks.find(t => t.key === 'inventory');
  assert.equal(inv.title, 'Check supply inventory for 130 people');
  assert.deepEqual(Object.keys(inv.assignees), ['kent']);
  assert.equal(tasks.find(t => t.key === 'recruit-santa').assignees && Object.keys(tasks.find(t => t.key === 'recruit-santa').assignees).length, 0);
  assert.equal(event.assignments.coordinator[0], 'neo');
  // first task goes out 51 days before, at 9 AM Central
  assert.equal(tasks[0].sendAt, '2026-10-16T14:00:00.000Z');
});

test('every playbook template resolves', () => {
  const ctx = {
    first: 'Kent', name: 'Kent Finger', eventName: 'GSC', venue: 'Hall', guests: 130, org: 'SFX KC', year: '2026', eventDate: '2026-12-06',
    coord: { name: 'Neo Chen', first: 'Neo', phone: '(504) 555-0100', email: 'neo@example.com' }, signature: 'Thanks', link: 'http://x/p',
  };
  for (const t of pb.tasks) {
    for (const s of [t.title, t.sms, t.email?.subject, t.email?.body]) assert.deepEqual(missingVars(s, { ...ctx }), [], `${t.key}: ${s?.slice(0, 40)}`);
    if (t.sms) assert.ok(render(t.sms, ctx).length + 40 < 320, `${t.key} SMS too long`);
  }
  assert.match(render('{{date -1}} / {{mdy 0}}', ctx), /^Saturday, December 5, 2026 \/ 12\/6\/2026$/);
});

test('nothing is sent by itself: ready -> sent by the coordinator -> remind at 48h -> call at 72h', () => {
  const { event, tasks } = make();
  const inv = tasks.find(t => t.key === 'inventory');
  const t0 = inv.sendAt;
  const at = h => new Date(Date.parse(t0) + h * 36e5).toISOString();
  const live = now => liveStatus(inv, inv.assignees.kent, people.kent, event.policy, now);

  assert.equal(live(at(-1)), 'scheduled');
  assert.equal(live(at(0)), 'ready');
  assert.equal(live(at(500)), 'ready', 'stays ready until the coordinator sends it');

  assert.equal(markSent(inv, 'kent', { now: at(10), name: 'Kent', channels: ['email'] }), 'initial');
  assert.equal(inv.assignees.kent.status, 'sent');
  assert.match(inv.log.at(-1).text, /Sent to Kent \(email\)/);
  assert.equal(live(at(57)), 'sent');
  assert.equal(live(at(58)), 'remind', '48h after it was sent');
  assert.equal(live(at(82)), 'call_needed', '72h after it was sent');

  // a reminder sent late still gives them a day before the call
  assert.equal(markSent(inv, 'kent', { now: at(80), name: 'Kent' }), 'reminder');
  assert.equal(inv.assignees.kent.status, 'reminded');
  assert.equal(inv.assignees.kent.sentAt, at(10), 'the first send keeps counting');
  assert.equal(live(at(103)), 'reminded');
  assert.equal(live(at(104)), 'call_needed');

  applyResponse(inv, 'kent', 'done', { now: at(105) });
  assert.equal(live(at(500)), 'done');
});

test('no email: the coordinator is asked to call; coordinator tasks become to-dos', () => {
  const { event, tasks } = make();
  const gifts = tasks.find(t => t.key === 'santa-gifts');
  assert.equal(liveStatus(gifts, gifts.assignees.gail, people.gail, event.policy, gifts.sendAt), 'call_needed');
  const team = tasks.find(t => t.key === 'confirm-team');
  assert.equal(liveStatus(team, team.assignees.neo, people.neo, event.policy, team.sendAt), 'todo');
  const [live] = withLiveStatus({ event, tasks: [team], people, now: team.sendAt });
  assert.equal(live.assignees.neo.status, 'todo');
  assert.equal(live.assignees.neo.saved, 'scheduled', 'the stored status is kept');
  assert.equal(team.assignees.neo.status, 'scheduled', 'the input is not changed');
});

test('SMS parsing', () => {
  assert.deepEqual(parseSms('1'), { type: 'done', note: '' });
  assert.deepEqual(parseSms(' Done! all bought '), { type: 'done', note: 'all bought' });
  assert.deepEqual(parseSms('2 need 2 propane refills'), { type: 'help', note: 'need 2 propane refills' });
  assert.equal(parseSms('STOP').type, 'stop');
  assert.equal(parseSms('help').type, 'helpinfo');
  assert.equal(parseSms('COOK John Smith').type, 'free');
  assert.equal(parseSms('Is the party at 3?').type, 'free');
  assert.equal(parseSms('10 people').type, 'free');
});

test('reply target is the most recently notified open item', () => {
  const tasks = [
    { id: 'a', kind: 'message', assignees: { kent: { status: 'sent', lastNotifiedAt: '2026-11-20T15:00:00Z' } } },
    { id: 'b', kind: 'message', assignees: { kent: { status: 'reminded', lastNotifiedAt: '2026-11-22T15:00:00Z' } } },
    { id: 'c', kind: 'message', assignees: { kent: { status: 'done', lastNotifiedAt: '2026-11-23T15:00:00Z' } } },
  ];
  const bcs = [{ id: 'bc', to: ['kent'], acks: {}, sentAt: '2026-11-21T00:00:00Z' }];
  assert.equal(pickReplyTarget('kent', tasks, bcs).item.id, 'b');
  bcs[0].sentAt = '2026-11-23T00:00:00Z';
  assert.equal(pickReplyTarget('kent', tasks, bcs).type, 'broadcast');
  assert.equal(pickReplyTarget('kent', tasks, bcs, { tasksOnly: true }).item.id, 'b');
});

test('applyResponse logs and channelsFor respects opt-out', () => {
  const t = { id: 'x', assignees: { kent: { status: 'sent' } }, log: [] };
  applyResponse(t, 'kent', 'help', { note: 'propane', now: 'n', by: 'sms', name: 'Kent' });
  assert.equal(t.assignees.kent.status, 'help');
  assert.match(t.log[0].text, /asked for help/);
  assert.deepEqual(channelsFor(people.kent), ['email'], 'email only unless texts are turned on');
  assert.deepEqual(channelsFor(people.kent, { sms: true }), ['sms', 'email']);
  assert.deepEqual(channelsFor({ phone: '+1', email: 'a@b', smsOptIn: false }, { sms: true }), ['email']);
  assert.deepEqual(channelsFor(people.gail, { sms: true }), []);
});

test('reassign keeps progress for people who stay', () => {
  const t = { roles: ['purchasing'], assignees: { kent: { status: 'done' } } };
  reassign(t, { purchasing: ['kent', 'neo'] });
  assert.equal(t.assignees.kent.status, 'done');
  assert.equal(t.assignees.neo.status, 'scheduled');
});

test('playbookFromEvent round-trips offsets and carries results forward', () => {
  const b = make();
  const pb2 = playbookFromEvent({ ...b, results: { fields: { party: '128', water: '20' }, expenses: [{ amount: 700.5 }], lessons: 'Buy 6 hot dog buns\nMore ice' } }, pb);
  assert.equal(pb2.version, 2);
  assert.deepEqual(pb2.tasks.map(t => [t.key, t.send, t.due]), pb.tasks.map(t => [t.key, t.send, t.due]));
  assert.equal(pb2.defaults.guests, 128);
  assert.equal(pb2.resultsForm[1].fields[0].last, '20');
  assert.deepEqual(pb2.lastYear.notes, ['Buy 6 hot dog buns', 'More ice']);
  const again = instantiate(pb2, { date: '2027-12-05', assignments });
  assert.equal(again.tasks[0].sendAt, zonedToUtc('2027-10-15', '09:00', 'America/Chicago'));
});

test('a just-sent announcement wins a timestamp tie', () => {
  const tasks = [{ id: 'a', kind: 'message', assignees: { kent: { status: 'sent', lastNotifiedAt: '2026-11-27T15:01:00Z' } } }];
  const bcs = [{ id: 'bc', to: ['kent'], acks: {}, sentAt: '2026-11-27T15:01:00Z' }];
  assert.equal(pickReplyTarget('kent', tasks, bcs).type, 'broadcast');
});
