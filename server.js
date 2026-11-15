'use strict';
/**
 * Clinic Booking API: zero dependencies, Node 18+.
 *
 * Why in-memory is safe for concurrency: Node runs JS on one thread, and every
 * check-then-write below happens synchronously (no await between checking a
 * slot and marking it booked), so two simultaneous requests can never both
 * win the same slot. If you move to a database, replace this with a UNIQUE
 * constraint / transaction on the slot.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'koya-clinic-key';

const RATE_LIMIT = 5; // attempts per email
const RATE_WINDOW_MS = 60 * 1000; // per minute
const MAX_BODY_BYTES = 100 * 1024;

// ---------------------------------------------------------------- state
let slots = []; // [{ ...original fields, id, start }]
let bookings = new Map(); // id -> booking
let slotToBooking = new Map(); // slot id -> confirmed booking id
let idempotency = new Map(); // key -> { hash, status, body }
let attempts = new Map(); // email -> [timestamps]

const START_FIELDS = ['start', 'starts_at', 'start_time', 'startsAt', 'startTime', 'datetime', 'time'];

function slotStartMs(slot) {
  for (const f of START_FIELDS) {
    if (slot[f] !== undefined) {
      const t = typeof slot[f] === 'number' ? slot[f] : Date.parse(slot[f]);
      if (!Number.isNaN(t)) return t;
    }
  }
  return NaN;
}

function defaultSlots() {
  const out = [];
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  let n = 1;
  for (let day = 1; day <= 5; day++) {
    for (const hour of [9, 10, 11, 13, 14, 15]) {
      const start = new Date(base.getTime() + day * 86400000 + hour * 3600000);
      const end = new Date(start.getTime() + 30 * 60000);
      out.push({ id: `s${n++}`, start: start.toISOString(), end: end.toISOString() });
    }
  }
  return out;
}

function loadSlots(list) {
  slots = list.map((s, i) => ({ ...s, id: String(s.id !== undefined ? s.id : `s${i + 1}`) }));
  bookings = new Map();
  slotToBooking = new Map();
  idempotency = new Map();
  attempts = new Map();
}
loadSlots(defaultSlots());

const publicSlot = (s) => ({ ...s, available: !slotToBooking.has(s.id) });

// ---------------------------------------------------------------- helpers
function send(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}
const fail = (res, status, message, headers) => send(res, status, { error: message }, headers);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
const hashBody = (b) => crypto.createHash('sha256').update(stableStringify(b)).digest('hex');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isStr = (v) => typeof v === 'string';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------- handlers
function handleReset(res, body) {
  let list = null;
  if (Array.isArray(body)) list = body;
  else if (body && Array.isArray(body.slots)) list = body.slots;
  if (list && list.some((s) => s === null || typeof s !== 'object' || Array.isArray(s))) {
    return fail(res, 400, 'slots must be objects');
  }
  loadSlots(list && list.length ? list : defaultSlots());
  return send(res, 200, { ok: true, slots: slots.length });
}

function handleListSlots(res, query) {
  let out = slots.map(publicSlot);
  if (query.get('available') === 'true') out = out.filter((s) => s.available);
  return send(res, 200, out);
}

/** Returns { status, body } and never throws; the caller stores/sends it. */
function createBooking(body) {
  const slotId = isStr(body.slot_id) ? body.slot_id.trim() : '';
  const name = isStr(body.name) ? body.name.trim() : '';
  const email = isStr(body.email) ? body.email.trim().toLowerCase() : '';

  if (!slotId) return { status: 400, body: { error: 'slot_id is required' } };
  if (!name) return { status: 400, body: { error: 'name is required' } };
  if (!email) return { status: 400, body: { error: 'email is required' } };
  if (!EMAIL_RE.test(email)) return { status: 400, body: { error: 'email is invalid' } };

  const slot = slots.find((s) => s.id === slotId);
  if (!slot) return { status: 404, body: { error: 'slot not found' } };

  const startMs = slotStartMs(slot);
  if (!Number.isNaN(startMs) && startMs <= Date.now()) {
    return { status: 400, body: { error: 'slot has already started' } };
  }

  // Check-and-set with no await in between = atomic.
  if (slotToBooking.has(slot.id)) return { status: 409, body: { error: 'slot already booked' } };

  const booking = {
    id: crypto.randomUUID(),
    slot_id: slot.id,
    name,
    email,
    status: 'confirmed',
    created_at: new Date().toISOString(),
  };
  bookings.set(booking.id, booking);
  slotToBooking.set(slot.id, booking.id);
  return { status: 201, body: booking };
}

/** Sliding window: returns 0 if allowed (and records the attempt), else seconds to wait. */
function takeAttempt(email) {
  const now = Date.now();
  const recent = (attempts.get(email) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    attempts.set(email, recent);
    return Math.max(1, Math.ceil((recent[0] + RATE_WINDOW_MS - now) / 1000));
  }
  recent.push(now);
  attempts.set(email, recent);
  return 0;
}

function handleCreateBooking(req, res, body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail(res, 400, 'body must be a JSON object');
  }
  const idemKey = req.headers['idempotency-key'];
  const hash = hashBody(body);

  // Exact replay: same key + same body returns the stored response, creates nothing.
  if (idemKey && idempotency.has(idemKey)) {
    const saved = idempotency.get(idemKey);
    if (saved.hash === hash) return send(res, saved.status, saved.body);
  }

  // Rate limit by email: every attempt counts, including ones that fail validation.
  if (isStr(body.email) && body.email.trim()) {
    const wait = takeAttempt(body.email.trim().toLowerCase());
    if (wait > 0) {
      return fail(res, 429, 'too many attempts for this email, try again later', { 'Retry-After': String(wait) });
    }
  }

  if (idemKey && idempotency.has(idemKey)) {
    return fail(res, 422, 'Idempotency-Key was already used with a different request body');
  }

  const result = createBooking(body);
  if (idemKey) idempotency.set(idemKey, { hash, ...result });
  return send(res, result.status, result.body);
}

function handleListBookings(res, query) {
  const emailRaw = query.get('email');
  if (!emailRaw || !emailRaw.trim()) return fail(res, 400, 'email query parameter is required');
  const email = emailRaw.trim().toLowerCase();

  const pageRaw = query.get('page');
  const limitRaw = query.get('limit');
  const page = pageRaw === null ? 1 : Number(pageRaw);
  const limit = limitRaw === null ? 10 : Number(limitRaw);
  if (!Number.isInteger(page) || page < 1) return fail(res, 400, 'page must be a positive integer');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return fail(res, 400, 'limit must be an integer between 1 and 100');
  }

  const mine = [...bookings.values()]
    .filter((b) => b.email === email)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  const total = mine.length;
  const data = mine.slice((page - 1) * limit, page * limit);
  return send(res, 200, { data, page, limit, total, total_pages: Math.ceil(total / limit) });
}

function handleGetBooking(res, id) {
  const b = bookings.get(id);
  return b ? send(res, 200, b) : fail(res, 404, 'booking not found');
}

function handleCancelBooking(res, id) {
  const b = bookings.get(id);
  if (!b) return fail(res, 404, 'booking not found');
  if (b.status !== 'cancelled') {
    b.status = 'cancelled';
    b.cancelled_at = new Date().toISOString();
    if (slotToBooking.get(b.slot_id) === b.id) slotToBooking.delete(b.slot_id); // frees the slot
  }
  return send(res, 200, b);
}

// ---------------------------------------------------------------- server
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/+$/, '') || '/';

    // The web page itself is public; it asks the visitor for the API key.
    if (req.method === 'GET' && p === '/') {
      const html = fs.readFileSync(INDEX_PATH);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
      return res.end(html);
    }

    // Level 2: every API request needs the key.
    const key = req.headers['x-api-key'];
    if (!key || !safeEqual(key, API_KEY)) return fail(res, 401, 'missing or invalid API key');

    let body = null;
    if (req.method === 'POST') {
      const raw = await readBody(req);
      if (raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch {
          return fail(res, 400, 'invalid JSON body');
        }
      }
    }

    if (req.method === 'POST' && p === '/reset') return handleReset(res, body);
    if (req.method === 'GET' && p === '/slots') return handleListSlots(res, url.searchParams);
    if (req.method === 'POST' && p === '/bookings') return handleCreateBooking(req, res, body === null ? {} : body);
    if (req.method === 'GET' && p === '/bookings') return handleListBookings(res, url.searchParams);

    const m = p.match(/^\/bookings\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (req.method === 'GET') return handleGetBooking(res, id);
      if (req.method === 'DELETE') return handleCancelBooking(res, id);
    }
    return fail(res, 404, 'not found');
  } catch (err) {
    if (err && err.status === 413) return fail(res, 413, 'body too large');
    console.error(err);
    return fail(res, 500, 'internal server error');
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Clinic booking API on :${PORT}`));
}
module.exports = server;
