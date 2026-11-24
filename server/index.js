const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
if (IS_PROD && !process.env.JWT_SECRET) {
  console.error('JWT_SECRET must be set in production');
  process.exit(1);
}
const ADMIN_EMAILS = (process.env.ADMIN_EMAIL || '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PAYMENTS_ENABLED = Boolean(STRIPE_KEY && STRIPE_PRICE);
const stripe = PAYMENTS_ENABLED ? require('stripe')(STRIPE_KEY) : null;
const PRICE_LABEL = process.env.PRICE_LABEL || '';

const FORUM_CATEGORIES = ['general', 'behavior', 'school', 'health', 'social', 'family', 'resources', 'self-care'];

// ---------- helpers ----------
const now = () => Date.now();
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = now();
  const arr = (buckets.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return false; }
  arr.push(t); buckets.set(key, arr); return true;
}
setInterval(() => buckets.clear(), 60 * 60 * 1000).unref();

function clean(str, max) {
  return String(str ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function isMember(u) {
  if (!u) return false;
  if (!PAYMENTS_ENABLED || u.role === 'admin') return true;
  return ['active', 'trialing'].includes(u.subscription_status);
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    lang: u.lang,
    role: u.role,
    subscriptionStatus: u.subscription_status,
    currentPeriodEnd: u.current_period_end,
    isMember: isMember(u),
  };
}

function setAuthCookie(res, user) {
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

async function userFromToken(token) {
  if (!token) return null;
  try {
    const { uid } = jwt.verify(token, JWT_SECRET);
    return await db.one('SELECT * FROM users WHERE id=$1', [uid]);
  } catch {
    return null;
  }
}

function baseUrl(req) {
  return process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`;
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function auth(req, res, next) {
  req.user = await userFromToken(req.cookies.token);
  next();
}
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'auth' });
  next();
}
function requireMember(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'auth' });
  if (!isMember(req.user)) return res.status(402).json({ error: 'membership' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}

// ---------- Stripe sync ----------
async function applySubscription(customerId, sub) {
  const status = sub ? sub.status : 'none';
  const end = sub ? (sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end) : null;
  await db.query(
    'UPDATE users SET subscription_status=$1, current_period_end=$2 WHERE stripe_customer_id=$3',
    [status, end ? new Date(end * 1000) : null, customerId]
  );
}

async function syncCustomer(customerId) {
  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
  const rank = { active: 0, trialing: 1, past_due: 2, unpaid: 3, incomplete: 4, canceled: 5, incomplete_expired: 6, paused: 7 };
  const best = subs.data.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.created - a.created)[0];
  await applySubscription(customerId, best || null);
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'DENY');
  next();
});

// Stripe webhook needs the raw body, so it is registered before express.json().
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), wrap(async (req, res) => {
  if (!PAYMENTS_ENABLED || !STRIPE_WEBHOOK_SECRET) return res.status(400).send('not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  const obj = event.data.object;
  if (event.type === 'checkout.session.completed' && obj.customer) {
    await syncCustomer(obj.customer);
  } else if (event.type.startsWith('customer.subscription.')) {
    await syncCustomer(obj.customer);
  }
  res.json({ received: true });
}));

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(wrap(auth));

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/api/config', (req, res) => {
  res.json({ paymentsEnabled: PAYMENTS_ENABLED, priceLabel: PRICE_LABEL, categories: FORUM_CATEGORIES });
});

// ----- auth -----
app.post('/api/register', wrap(async (req, res) => {
  if (!rateLimit(`reg:${req.ip}`, 10, 60 * 60 * 1000)) return res.status(429).json({ error: 'rate' });
  const email = clean(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  const displayName = clean(req.body.displayName, 40);
  const lang = req.body.lang === 'en' ? 'en' : 'es';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'email' });
  if (password.length < 8) return res.status(400).json({ error: 'password' });
  if (displayName.length < 2) return res.status(400).json({ error: 'name' });
  const exists = await db.one('SELECT id FROM users WHERE email=$1', [email]);
  if (exists) return res.status(409).json({ error: 'exists' });
  const hash = await bcrypt.hash(password, 11);
  const role = ADMIN_EMAILS.includes(email) ? 'admin' : 'member';
  const user = await db.one(
    `INSERT INTO users (email, password_hash, display_name, lang, role) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [email, hash, displayName, lang, role]
  );
  setAuthCookie(res, user);
  res.json({ user: publicUser(user) });
}));

app.post('/api/login', wrap(async (req, res) => {
  if (!rateLimit(`login:${req.ip}`, 20, 15 * 60 * 1000)) return res.status(429).json({ error: 'rate' });
  const email = clean(req.body.email, 200).toLowerCase();
  let user = await db.one('SELECT * FROM users WHERE email=$1', [email]);
  const ok = user && (await bcrypt.compare(String(req.body.password || ''), user.password_hash));
  if (!ok) return res.status(401).json({ error: 'credentials' });
  if (ADMIN_EMAILS.includes(email) && user.role !== 'admin') {
    user = await db.one(`UPDATE users SET role='admin' WHERE id=$1 RETURNING *`, [user.id]);
  }
  setAuthCookie(res, user);
  res.json({ user: publicUser(user) });
}));

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

app.patch('/api/me', requireUser, wrap(async (req, res) => {
  const displayName = req.body.displayName != null ? clean(req.body.displayName, 40) : req.user.display_name;
  const lang = req.body.lang === 'en' ? 'en' : req.body.lang === 'es' ? 'es' : req.user.lang;
  if (displayName.length < 2) return res.status(400).json({ error: 'name' });
  const user = await db.one('UPDATE users SET display_name=$1, lang=$2 WHERE id=$3 RETURNING *', [displayName, lang, req.user.id]);
  res.json({ user: publicUser(user) });
}));

// ----- billing -----
app.post('/api/billing/checkout', requireUser, wrap(async (req, res) => {
  if (!PAYMENTS_ENABLED) return res.status(400).json({ error: 'payments_disabled' });
  let customerId = req.user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: req.user.email, metadata: { userId: String(req.user.id) } });
    customerId = customer.id;
    await db.query('UPDATE users SET stripe_customer_id=$1 WHERE id=$2', [customerId, req.user.id]);
  }
  const base = baseUrl(req);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: String(req.user.id),
    line_items: [{ price: STRIPE_PRICE, quantity: 1 }],
    locale: req.user.lang === 'en' ? 'en' : 'es',
    success_url: `${base}/?checkout=success#/account`,
    cancel_url: `${base}/#/join`,
  });
  res.json({ url: session.url });
}));

app.post('/api/billing/portal', requireUser, wrap(async (req, res) => {
  if (!PAYMENTS_ENABLED || !req.user.stripe_customer_id) return res.status(400).json({ error: 'no_customer' });
  const session = await stripe.billingPortal.sessions.create({
    customer: req.user.stripe_customer_id,
    return_url: `${baseUrl(req)}/#/account`,
  });
  res.json({ url: session.url });
}));

app.post('/api/billing/sync', requireUser, wrap(async (req, res) => {
  if (PAYMENTS_ENABLED && req.user.stripe_customer_id) await syncCustomer(req.user.stripe_customer_id);
  const user = await db.one('SELECT * FROM users WHERE id=$1', [req.user.id]);
  res.json({ user: publicUser(user) });
}));

// ----- chat rooms -----
app.get('/api/rooms', requireMember, wrap(async (req, res) => {
  const rooms = await db.query(
    `SELECT r.*, (SELECT max(m.created_at) FROM messages m WHERE m.room_id=r.id AND NOT m.deleted) AS last_message_at
     FROM rooms r ORDER BY sort`
  );
  res.json({ rooms });
}));

app.get('/api/rooms/:slug/messages', requireMember, wrap(async (req, res) => {
  const room = await db.one('SELECT * FROM rooms WHERE slug=$1', [req.params.slug]);
  if (!room) return res.status(404).json({ error: 'not_found' });
  const before = parseInt(req.query.before, 10) || 2147483647;
  const rows = await db.query(
    `SELECT m.id, m.body, m.created_at, m.user_id, u.display_name
     FROM messages m JOIN users u ON u.id=m.user_id
     WHERE m.room_id=$1 AND NOT m.deleted AND m.id < $2
     ORDER BY m.id DESC LIMIT 50`,
    [room.id, before]
  );
  res.json({ room, messages: rows.reverse() });
}));

// ----- forum -----
app.get('/api/posts', requireMember, wrap(async (req, res) => {
  const cat = FORUM_CATEGORIES.includes(req.query.category) ? req.query.category : null;
  const rows = await db.query(
    `SELECT p.id, p.title, p.category, p.created_at, p.last_activity, p.user_id, u.display_name,
            (SELECT count(*)::int FROM replies r WHERE r.post_id=p.id AND NOT r.deleted) AS reply_count
     FROM posts p JOIN users u ON u.id=p.user_id
     WHERE NOT p.deleted AND ($1::text IS NULL OR p.category=$1)
     ORDER BY p.last_activity DESC LIMIT 100`,
    [cat]
  );
  res.json({ posts: rows });
}));

app.post('/api/posts', requireMember, wrap(async (req, res) => {
  if (!rateLimit(`post:${req.user.id}`, 10, 60 * 60 * 1000)) return res.status(429).json({ error: 'rate' });
  const title = clean(req.body.title, 150);
  const body = clean(req.body.body, 5000);
  const category = FORUM_CATEGORIES.includes(req.body.category) ? req.body.category : 'general';
  if (title.length < 3 || body.length < 1) return res.status(400).json({ error: 'empty' });
  const post = await db.one(
    'INSERT INTO posts (user_id, category, title, body) VALUES ($1,$2,$3,$4) RETURNING id',
    [req.user.id, category, title, body]
  );
  res.json({ id: post.id });
}));

app.get('/api/posts/:id', requireMember, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const post = await db.one(
    `SELECT p.*, u.display_name FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$1 AND NOT p.deleted`,
    [id]
  );
  if (!post) return res.status(404).json({ error: 'not_found' });
  const replies = await db.query(
    `SELECT r.id, r.body, r.created_at, r.user_id, u.display_name
     FROM replies r JOIN users u ON u.id=r.user_id
     WHERE r.post_id=$1 AND NOT r.deleted ORDER BY r.id`,
    [id]
  );
  res.json({ post, replies });
}));

app.post('/api/posts/:id/replies', requireMember, wrap(async (req, res) => {
  if (!rateLimit(`reply:${req.user.id}`, 30, 60 * 60 * 1000)) return res.status(429).json({ error: 'rate' });
  const id = parseInt(req.params.id, 10);
  const body = clean(req.body.body, 5000);
  if (!body) return res.status(400).json({ error: 'empty' });
  const post = await db.one('SELECT id FROM posts WHERE id=$1 AND NOT deleted', [id]);
  if (!post) return res.status(404).json({ error: 'not_found' });
  await db.query('INSERT INTO replies (post_id, user_id, body) VALUES ($1,$2,$3)', [id, req.user.id, body]);
  await db.query('UPDATE posts SET last_activity=now() WHERE id=$1', [id]);
  res.json({ ok: true });
}));

app.delete('/api/posts/:id', requireMember, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const post = await db.one('SELECT user_id FROM posts WHERE id=$1', [id]);
  if (!post) return res.status(404).json({ error: 'not_found' });
  if (post.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  await db.query('UPDATE posts SET deleted=true WHERE id=$1', [id]);
  res.json({ ok: true });
}));

app.delete('/api/replies/:id', requireMember, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await db.one('SELECT user_id FROM replies WHERE id=$1', [id]);
  if (!r) return res.status(404).json({ error: 'not_found' });
  if (r.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  await db.query('UPDATE replies SET deleted=true WHERE id=$1', [id]);
  res.json({ ok: true });
}));

// ----- reports & admin -----
app.post('/api/reports', requireMember, wrap(async (req, res) => {
  if (!rateLimit(`report:${req.user.id}`, 20, 60 * 60 * 1000)) return res.status(429).json({ error: 'rate' });
  const kind = ['message', 'post', 'reply'].includes(req.body.kind) ? req.body.kind : null;
  const targetId = parseInt(req.body.targetId, 10);
  if (!kind || !targetId) return res.status(400).json({ error: 'bad' });
  await db.query('INSERT INTO reports (user_id, kind, target_id, reason) VALUES ($1,$2,$3,$4)',
    [req.user.id, kind, targetId, clean(req.body.reason, 500)]);
  res.json({ ok: true });
}));

app.get('/api/admin/reports', requireAdmin, wrap(async (req, res) => {
  const rows = await db.query(
    `SELECT rp.*, u.display_name AS reporter,
       CASE rp.kind
         WHEN 'message' THEN (SELECT body FROM messages WHERE id=rp.target_id)
         WHEN 'post' THEN (SELECT title || ': ' || body FROM posts WHERE id=rp.target_id)
         WHEN 'reply' THEN (SELECT body FROM replies WHERE id=rp.target_id)
       END AS content
     FROM reports rp JOIN users u ON u.id=rp.user_id
     WHERE NOT rp.resolved ORDER BY rp.id DESC LIMIT 100`
  );
  res.json({ reports: rows });
}));

app.post('/api/admin/reports/:id/resolve', requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rp = await db.one('SELECT * FROM reports WHERE id=$1', [id]);
  if (!rp) return res.status(404).json({ error: 'not_found' });
  if (req.body.removeContent) {
    const table = { message: 'messages', post: 'posts', reply: 'replies' }[rp.kind];
    await db.query(`UPDATE ${table} SET deleted=true WHERE id=$1`, [rp.target_id]);
    if (rp.kind === 'message') io.emit('deleted', { id: rp.target_id });
  }
  await db.query('UPDATE reports SET resolved=true WHERE id=$1', [id]);
  res.json({ ok: true });
}));

// ----- static frontend -----
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: IS_PROD ? '1h' : 0 }));
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server' });
});

// ---------- realtime chat ----------
const server = http.createServer(app);
const io = new Server(server);

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? [p.trim(), ''] : [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())];
  }));
}

io.use(async (socket, next) => {
  const token = parseCookies(socket.handshake.headers.cookie).token;
  const user = await userFromToken(token);
  if (!user) return next(new Error('auth'));
  if (!isMember(user)) return next(new Error('membership'));
  socket.data.user = user;
  next();
});

async function emitPresence(slug) {
  const sockets = await io.in(`room:${slug}`).fetchSockets();
  const ids = new Set(sockets.map((s) => s.data.user.id));
  io.to(`room:${slug}`).emit('presence', { slug, count: ids.size });
}

io.on('connection', (socket) => {
  socket.on('join', async (slug, ack) => {
    try {
      for (const r of socket.rooms) {
        if (r.startsWith('room:')) { socket.leave(r); emitPresence(r.slice(5)); }
      }
      socket.data.roomId = null;
      socket.data.slug = null;
      const room = await db.one('SELECT id, slug FROM rooms WHERE slug=$1', [String(slug)]);
      if (!room) return ack?.({ error: 'not_found' });
      socket.data.roomId = room.id;
      socket.data.slug = room.slug;
      socket.join(`room:${room.slug}`);
      ack?.({ ok: true });
      emitPresence(room.slug);
    } catch (e) { console.error(e); ack?.({ error: 'server' }); }
  });

  socket.on('message', async (payload, ack) => {
    try {
      const u = socket.data.user;
      if (!socket.data.roomId) return ack?.({ error: 'no_room' });
      if (!rateLimit(`msg:${u.id}`, 10, 10 * 1000)) return ack?.({ error: 'rate' });
      const body = clean(payload?.body, 2000);
      if (!body) return ack?.({ error: 'empty' });
      const row = await db.one(
        'INSERT INTO messages (room_id, user_id, body) VALUES ($1,$2,$3) RETURNING id, created_at',
        [socket.data.roomId, u.id, body]
      );
      const msg = { id: row.id, body, created_at: row.created_at, user_id: u.id, display_name: u.display_name };
      io.to(`room:${socket.data.slug}`).emit('message', msg);
      ack?.({ ok: true });
    } catch (e) { console.error(e); ack?.({ error: 'server' }); }
  });

  socket.on('delete', async (id, ack) => {
    try {
      const u = socket.data.user;
      const m = await db.one('SELECT user_id FROM messages WHERE id=$1', [parseInt(id, 10)]);
      if (!m) return ack?.({ error: 'not_found' });
      if (m.user_id !== u.id && u.role !== 'admin') return ack?.({ error: 'forbidden' });
      await db.query('UPDATE messages SET deleted=true WHERE id=$1', [parseInt(id, 10)]);
      io.emit('deleted', { id: parseInt(id, 10) });
      ack?.({ ok: true });
    } catch (e) { console.error(e); ack?.({ error: 'server' }); }
  });

  socket.on('disconnecting', () => {
    for (const r of socket.rooms) {
      if (r.startsWith('room:')) setTimeout(() => emitPresence(r.slice(5)), 50);
    }
  });
});

db.init().then(() => {
  server.listen(PORT, () => {
    console.log(`Círculo Azul running on http://localhost:${PORT}`);
    console.log(`Payments: ${PAYMENTS_ENABLED ? 'Stripe enabled' : 'disabled (free access mode)'}`);
  });
}).catch((err) => {
  console.error('Failed to start', err);
  process.exit(1);
});
