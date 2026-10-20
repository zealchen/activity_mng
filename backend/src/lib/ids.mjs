import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomId(len = 10) {
  const bytes = randomBytes(len);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export const newId = prefix => `${prefix}_${randomId(8)}`;
export const newToken = () => randomId(12);

/** '(504) 555-0144' or '504-555-0144' -> '+15045550144' (US default). */
export function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits ? `+${digits}` : '';
}

export function displayPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 || '';
}
