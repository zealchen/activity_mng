// Shared helpers for every page.
window.CFG = window.APP_CONFIG || { apiBase: '' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function linkify(text) {
  return esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

async function request(method, path, body, headers = {}) {
  const r = await fetch(CFG.apiBase + path, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || `Request failed (${r.status})`); e.status = r.status; throw e; }
  return data;
}

function toast(msg, isErr) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), isErr ? 4500 : 2400);
}

const fmt = {
  date: (iso, tz) => new Date(iso).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }),
  dateLong: (iso, tz) => new Date(iso).toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
  dt: (iso, tz) => new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
  time: (iso, tz) => new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }),
  ymd: ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); },
  money: n => `$${(Number(n) || 0).toFixed(2)}`,
};

const STATUS = {
  scheduled: 'Scheduled', ready: 'Ready to send', todo: 'To do', sent: 'Sent - waiting', remind: 'Send a reminder',
  reminded: 'Reminder sent', call_needed: 'Call needed',
  called: 'Called', done: 'Done', help: 'Needs help', unassigned: 'Nobody assigned',
};
const pill = s => `<span class="pill s-${s}">${STATUS[s] || s}</span>`;

/** Downscale a photo before upload so receipts stay small. */
function fileToDataUrl(file, max = 1600) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); return; }
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
