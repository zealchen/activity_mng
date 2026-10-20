// Date helpers. Event dates are plain 'YYYY-MM-DD' strings in the event's own
// timezone; instants (sendAt, dueAt, message times) are ISO-8601 UTC strings.

const pad = n => String(n).padStart(2, '0');

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function tzOffsetMs(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ts;
}

/** Wall-clock time in `tz` -> ISO UTC instant. */
export function zonedToUtc(ymd, hm, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [H, M] = hm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, H, M);
  let t = guess - tzOffsetMs(guess, tz);
  const second = guess - tzOffsetMs(t, tz);
  if (second !== t) t = second;
  return new Date(t).toISOString();
}

/** ISO instant -> 'YYYY-MM-DD' in `tz`. */
export function localYmd(iso, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function daysBetween(fromYmd, toYmd) {
  const a = Date.UTC(...fromYmd.split('-').map((v, i) => (i === 1 ? v - 1 : +v)));
  const b = Date.UTC(...toYmd.split('-').map((v, i) => (i === 1 ? v - 1 : +v)));
  return Math.round((b - a) / 864e5);
}

/** 'Saturday, December 5, 2026' */
export function longDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

/** '12/5/2026' */
export function mdy(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

export const hoursBetween = (aIso, bIso) => (Date.parse(bIso) - Date.parse(aIso)) / 36e5;
