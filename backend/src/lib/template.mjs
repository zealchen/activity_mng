// Tiny template renderer for playbook messages.
//   {{first}}, {{coord.name}}       -> value lookup (dotted paths)
//   {{date -1}}                     -> 'Saturday, December 5, 2026' (event day + offset)
//   {{mdy 0}}                       -> '12/6/2026'
// Unknown variables render as an empty string, so a typo never leaks '{{...}}'
// into a text message; tests assert every shipped template resolves.
import { addDays, longDate, mdy } from './time.mjs';

export function render(str, ctx) {
  if (!str) return '';
  return str.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    const fn = expr.match(/^(date|mdy)\s+(-?\d+)$/);
    if (fn) {
      if (!ctx.eventDate) return '';
      const day = addDays(ctx.eventDate, Number(fn[2]));
      return fn[1] === 'date' ? longDate(day) : mdy(day);
    }
    const v = expr.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
    return v == null ? '' : String(v);
  });
}

/** Variables a template references that the context cannot resolve. */
export function missingVars(str, ctx) {
  const out = [];
  for (const [, expr] of (str || '').matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    if (/^(date|mdy)\s+-?\d+$/.test(expr)) continue;
    const v = expr.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
    if (v == null) out.push(expr);
  }
  return out;
}
