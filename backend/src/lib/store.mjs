// DynamoDB single-table storage.
//
//   pk                 sk                 item
//   PEOPLE             P#<pid>            person
//   PLAYBOOKS          <id>#v<0000n>      playbook
//   EVENTS             <eid>              event summary (for listing)
//   EVENT#<eid>        META               event
//   EVENT#<eid>        TASK#<tid>         task
//   EVENT#<eid>        BC#<bid>           broadcast
//   EVENT#<eid>        SHIFT#<sid>        volunteer shift
//   EVENT#<eid>        SHOP#<iid>         shopping item
//   EVENT#<eid>        RESULT             results form + expenses
//   MSGS#<eid>         <iso>#<id>         message log (in + out)
//   TOKEN#<token>      T                  magic link -> {eventId, pid}
//   SETTINGS           CLOCK              dev clock override
//
// Every item carries a revision counter `rev`; writes are conditional so the
// scheduler and an inbound SMS can never silently overwrite each other.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.TABLE_NAME || 'activity-mng';
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
});

const strip = it => { if (!it) return it; const { pk, sk, ...rest } = it; return rest; };

export async function get(pk, sk) {
  const r = await doc.send(new GetCommand({ TableName: TABLE, Key: { pk, sk } }));
  return r.Item ? strip(r.Item) : null;
}

export async function queryAll(pk, { prefix, limit, desc } = {}) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await doc.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: prefix ? 'pk = :pk AND begins_with(sk, :p)' : 'pk = :pk',
      ExpressionAttributeValues: prefix ? { ':pk': pk, ':p': prefix } : { ':pk': pk },
      ScanIndexForward: !desc,
      ExclusiveStartKey,
      ...(limit ? { Limit: limit } : {}),
    }));
    items.push(...r.Items);
    ExclusiveStartKey = limit && items.length >= limit ? undefined : r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

export class ConflictError extends Error {}

/** Conditional put: succeeds only if the stored revision still matches. */
export async function put(pk, sk, item, { expectVersion } = {}) {
  const rev = (item.rev || 0) + 1;
  const cond = expectVersion === undefined
    ? {}
    : expectVersion === 0
      ? { ConditionExpression: 'attribute_not_exists(pk)' }
      : { ConditionExpression: 'rev = :v', ExpressionAttributeValues: { ':v': expectVersion } };
  try {
    await doc.send(new PutCommand({ TableName: TABLE, Item: { ...item, pk, sk, rev }, ...cond }));
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') throw new ConflictError(`${pk}/${sk} changed`);
    throw e;
  }
  return { ...item, rev };
}

/** Read-modify-write with optimistic retries. fn may return a new item or mutate in place. */
export async function mutate(pk, sk, fn, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const cur = await get(pk, sk);
    if (!cur) throw new Error(`Not found: ${pk}/${sk}`);
    const draft = structuredClone(cur);
    const next = (await fn(draft)) || draft;
    try { return await put(pk, sk, next, { expectVersion: cur.rev || 0 }); } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }
  throw new ConflictError(`Too many concurrent updates on ${pk}/${sk}`);
}

export async function del(pk, sk) {
  await doc.send(new DeleteCommand({ TableName: TABLE, Key: { pk, sk } }));
}

/* ---------- typed helpers ---------- */
export const K = {
  person: pid => ['PEOPLE', `P#${pid}`],
  event: eid => [`EVENT#${eid}`, 'META'],
  eventIndex: eid => ['EVENTS', eid],
  task: (eid, tid) => [`EVENT#${eid}`, `TASK#${tid}`],
  bc: (eid, bid) => [`EVENT#${eid}`, `BC#${bid}`],
  shift: (eid, sid) => [`EVENT#${eid}`, `SHIFT#${sid}`],
  shop: (eid, iid) => [`EVENT#${eid}`, `SHOP#${iid}`],
  result: eid => [`EVENT#${eid}`, 'RESULT'],
  token: tok => [`TOKEN#${tok}`, 'T'],
  clock: () => ['SETTINGS', 'CLOCK'],
};

export async function listPeople() {
  return (await queryAll('PEOPLE')).map(strip);
}

export async function peopleById() {
  return Object.fromEntries((await listPeople()).map(p => [p.id, p]));
}

export async function listEvents() {
  return (await queryAll('EVENTS')).map(strip);
}

export async function listPlaybooks() {
  return (await queryAll('PLAYBOOKS')).map(strip);
}

export async function latestPlaybook(id) {
  const all = (await queryAll('PLAYBOOKS', { prefix: `${id}#v` })).map(strip);
  return all[all.length - 1] || null;
}

export async function savePlaybook({ rev, ...pb }) {
  return put('PLAYBOOKS', `${pb.id}#v${String(pb.version).padStart(5, '0')}`, pb);
}

/** Everything under one event, sorted into buckets. */
export async function loadBundle(eid) {
  const items = await queryAll(`EVENT#${eid}`);
  const b = { event: null, tasks: [], broadcasts: [], shifts: [], shopping: [], results: null };
  for (const it of items) {
    const v = strip(it);
    if (it.sk === 'META') b.event = v;
    else if (it.sk === 'RESULT') b.results = v;
    else if (it.sk.startsWith('TASK#')) b.tasks.push(v);
    else if (it.sk.startsWith('BC#')) b.broadcasts.push(v);
    else if (it.sk.startsWith('SHIFT#')) b.shifts.push(v);
    else if (it.sk.startsWith('SHOP#')) b.shopping.push(v);
  }
  b.tasks.sort((x, y) => (x.sendAt < y.sendAt ? -1 : x.sendAt > y.sendAt ? 1 : 0));
  b.shifts.sort((x, y) => (x.startAt < y.startAt ? -1 : 1));
  b.broadcasts.sort((x, y) => (x.sentAt < y.sentAt ? -1 : 1));
  return b;
}

export async function logMessage(eid, msg) {
  await put(`MSGS#${eid || 'none'}`, `${msg.at}#${msg.id}`, msg);
}

export async function listMessages(eid, { limit = 500 } = {}) {
  return (await queryAll(`MSGS#${eid}`, { desc: true, limit })).map(strip);
}
