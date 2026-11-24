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
    bio: u.bio || '',
    location: u.location || '',
    teenInfo: u.teen_info || '',
    interests: u.interests || '',
    avatar: u.avatar || null,
    allowDms: u.allow_dms !== false,
  };
}

// What other members can see about someone (never the email).
function profileOf(u) {
  return {
    id: u.id,
    displayName: u.display_name,
    role: u.role,
    bio: u.bio || '',
    location: u.location || '',
    teenInfo: u.teen_info || '',
    interests: u.interests || '',
    avatar: u.avatar || null,
    allowDms: u.allow_dms !== false,
    memberSince: u.created_at,
  };
}

const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

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

app.use(express.json({ limit: '400kb' }));
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
  const u = req.user;
  const b = req.body || {};
  const displayName = b.displayName != null ? clean(b.displayName, 40) : u.display_name;
  const lang = b.lang === 'en' ? 'en' : b.lang === 'es' ? 'es' : u.lang;
  if (displayName.length < 2) return res.status(400).json({ error: 'name' });
  const bio = b.bio != null ? clean(b.bio, 600) : u.bio;
  const location = b.location != null ? clean(b.location, 80) : u.location;
  const teenInfo = b.teenInfo != null ? clean(b.teenInfo, 160) : u.teen_info;
  const interests = b.interests != null ? clean(b.interests, 200) : u.interests;
  const allowDms = b.allowDms != null ? Boolean(b.allowDms) : u.allow_dms;
  let avatar = u.avatar;
  if (b.avatar === null) avatar = null;
  else if (typeof b.avatar === 'string') {
    if (b.avatar.length > 300000 || !AVATAR_RE.test(b.avatar)) return res.status(400).json({ error: 'avatar' });
    avatar = b.avatar;
  }
  const user = await db.one(
    `UPDATE users SET display_name=$1, lang=$2, bio=$3, location=$4, teen_info=$5, interests=$6, allow_dms=$7, avatar=$8
     WHERE id=$9 RETURNING *`,
    [displayName, lang, bio, location, teenInfo, interests, allowDms, avatar, u.id]
  );
  res.json({ user: publicUser(user) });
}));

// ----- members & profiles -----
app.get('/api/members', requireMember, wrap(async (req, res) => {
  const q = clean(req.query.q, 60);
  const rows = await db.query(
    `SELECT * FROM users
     WHERE ($1 = '' OR display_name ILIKE '%' || $1 || '%' OR location ILIKE '%' || $1 || '%' OR interests ILIKE '%' || $1 || '%')
     ORDER BY (avatar IS NOT NULL OR bio <> '') DESC, created_at DESC LIMIT 200`,
    [q]
  );
  res.json({ members: rows.filter(isMember).map(profileOf) });
}));

app.get('/api/users/:id', requireMember, wrap(async (req, res) => {
  const u = await db.one('SELECT * FROM users WHERE id=$1', [parseInt(req.params.id, 10) || 0]);
  if (!u) return res.status(404).json({ error: 'not_found' });
  const blocked = await db.one('SELECT 1 AS x FROM blocks WHERE user_id=$1 AND blocked_id=$2', [req.user.id, u.id]);
  const posts = await db.query(
    `SELECT id, title, category, created_at FROM posts WHERE user_id=$1 AND NOT deleted ORDER BY id DESC LIMIT 5`, [u.id]);
  res.json({ profile: profileOf(u), blockedByMe: Boolean(blocked), posts });
}));

app.post('/api/blocks/:id', requireMember, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || id === req.user.id) return res.status(400).json({ error: 'bad' });
  await db.query('INSERT INTO blocks (user_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, id]);
  res.json({ ok: true });
}));
app.delete('/api/blocks/:id', requireMember, wrap(async (req, res) => {
  await db.query('DELETE FROM blocks WHERE user_id=$1 AND blocked_id=$2', [req.user.id, parseInt(req.params.id, 10) || 0]);
  res.json({ ok: true });
}));

// ----- private messages -----
app.get('/api/dms', requireMember, wrap(async (req, res) => {
  const me = req.user.id;
  const rows = await db.query(
    `SELECT DISTINCT ON (other) other, id, body, created_at, sender_id, read_at FROM (
       SELECT CASE WHEN sender_id=$1 THEN recipient_id ELSE sender_id END AS other, id, body, created_at, sender_id, read_at
       FROM direct_messages WHERE (sender_id=$1 OR recipient_id=$1) AND NOT deleted
     ) t ORDER BY other, id DESC`,
    [me]
  );
  const unread = await db.query(
    `SELECT sender_id, count(*)::int AS n FROM direct_messages WHERE recipient_id=$1 AND read_at IS NULL AND NOT deleted GROUP BY sender_id`, [me]);
  const unreadBy = Object.fromEntries(unread.map((r) => [r.sender_id, r.n]));
  const ids = rows.map((r) => r.other);
  const users = ids.length ? await db.query('SELECT * FROM users WHERE id = ANY($1::int[])', [ids]) : [];
  const byId = Object.fromEntries(users.map((u) => [u.id, profileOf(u)]));
  const conversations = rows
    .filter((r) => byId[r.other])
    .map((r) => ({ user: byId[r.other], last: { body: r.body, created_at: r.created_at, mine: r.sender_id === me }, unread: unreadBy[r.other] || 0 }))
    .sort((a, b) => new Date(b.last.created_at) - new Date(a.last.created_at));
  res.json({ conversations });
}));

app.get('/api/dms/unread', requireUser, wrap(async (req, res) => {
  const r = await db.one(`SELECT count(*)::int AS n FROM direct_messages WHERE recipient_id=$1 AND read_at IS NULL AND NOT deleted`, [req.user.id]);
  res.json({ unread: r.n });
}));

app.get('/api/dms/:id', requireMember, wrap(async (req, res) => {
  const me = req.user.id;
  const other = await db.one('SELECT * FROM users WHERE id=$1', [parseInt(req.params.id, 10) || 0]);
  if (!other || other.id === me) return res.status(404).json({ error: 'not_found' });
  const msgs = await db.query(
    `SELECT id, sender_id, recipient_id, body, created_at FROM direct_messages
     WHERE ((sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1)) AND NOT deleted
     ORDER BY id DESC LIMIT 200`,
    [me, other.id]
  );
  await db.query('UPDATE direct_messages SET read_at=now() WHERE recipient_id=$1 AND sender_id=$2 AND read_at IS NULL', [me, other.id]);
  const blocked = await db.one('SELECT 1 AS x FROM blocks WHERE user_id=$1 AND blocked_id=$2', [me, other.id]);
  res.json({ user: profileOf(other), messages: msgs.reverse(), blockedByMe: Boolean(blocked) });
}));

app.post('/api/dms/:id', requireMember, wrap(async (req, res) => {
  const me = req.user;
  if (!rateLimit(`dm:${me.id}`, 30, 60 * 1000)) return res.status(429).json({ error: 'rate' });
  const other = await db.one('SELECT * FROM users WHERE id=$1', [parseInt(req.params.id, 10) || 0]);
  if (!other || other.id === me.id || !isMember(other)) return res.status(404).json({ error: 'not_found' });
  const body = clean(req.body.body, 2000);
  if (!body) return res.status(400).json({ error: 'empty' });
  const blocked = await db.one(
    'SELECT 1 AS x FROM blocks WHERE (user_id=$1 AND blocked_id=$2) OR (user_id=$2 AND blocked_id=$1)', [other.id, me.id]);
  if (blocked || other.allow_dms === false) return res.status(403).json({ error: 'dm_closed' });
  const row = await db.one(
    'INSERT INTO direct_messages (sender_id, recipient_id, body) VALUES ($1,$2,$3) RETURNING id, sender_id, recipient_id, body, created_at',
    [me.id, other.id, body]
  );
  const payload = { ...row, sender_name: me.display_name };
  io.to(`user:${other.id}`).emit('dm', payload);
  io.to(`user:${me.id}`).emit('dm', payload);
  res.json({ message: row });
}));

// ----- events -----
app.get('/api/events', requireMember, wrap(async (req, res) => {
  const rows = await db.query(
    `SELECT e.*, (SELECT count(*)::int FROM event_rsvps r WHERE r.event_id=e.id) AS going,
            EXISTS(SELECT 1 FROM event_rsvps r WHERE r.event_id=e.id AND r.user_id=$1) AS me_going
     FROM events e WHERE NOT e.deleted AND e.starts_at > now() - interval '30 days'
     ORDER BY e.starts_at`,
    [req.user.id]
  );
  res.json({ events: rows });
}));

app.post('/api/events', requireAdmin, wrap(async (req, res) => {
  const title = clean(req.body.title, 150);
  const description = clean(req.body.description, 3000);
  const link = clean(req.body.link, 500);
  const starts = new Date(req.body.startsAt);
  const duration = Math.min(Math.max(parseInt(req.body.durationMin, 10) || 60, 15), 600);
  const lang = ['es', 'en', 'both'].includes(req.body.lang) ? req.body.lang : 'es';
  if (title.length < 3 || isNaN(starts)) return res.status(400).json({ error: 'bad' });
  if (link && !/^https:\/\//i.test(link)) return res.status(400).json({ error: 'link' });
  const ev = await db.one(
    `INSERT INTO events (title, description, starts_at, duration_min, link, lang, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [title, description, starts, duration, link, lang, req.user.id]
  );
  res.json({ id: ev.id });
}));

app.delete('/api/events/:id', requireAdmin, wrap(async (req, res) => {
  await db.query('UPDATE events SET deleted=true WHERE id=$1', [parseInt(req.params.id, 10) || 0]);
  res.json({ ok: true });
}));

app.post('/api/events/:id/rsvp', requireMember, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const ev = await db.one('SELECT id FROM events WHERE id=$1 AND NOT deleted', [id]);
  if (!ev) return res.status(404).json({ error: 'not_found' });
  if (req.body.going) await db.query('INSERT INTO event_rsvps (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, req.user.id]);
  else await db.query('DELETE FROM event_rsvps WHERE event_id=$1 AND user_id=$2', [id, req.user.id]);
  res.json({ ok: true });
}));

// ----- member home / dashboard -----
app.get('/api/home', requireMember, wrap(async (req, res) => {
  const me = req.user.id;
  const [events, posts, rooms, unread, newMembers, counts] = await Promise.all([
    db.query(`SELECT id, title, starts_at, lang FROM events WHERE NOT deleted AND starts_at > now() - interval '2 hours' ORDER BY starts_at LIMIT 3`),
    db.query(`SELECT p.id, p.title, p.category, p.last_activity, u.display_name,
                (SELECT count(*)::int FROM replies r WHERE r.post_id=p.id AND NOT r.deleted) AS reply_count
              FROM posts p JOIN users u ON u.id=p.user_id WHERE NOT p.deleted ORDER BY p.last_activity DESC LIMIT 5`),
    db.query(`SELECT r.slug, r.icon, r.name_en, r.name_es, count(m.id)::int AS n
              FROM rooms r JOIN messages m ON m.room_id=r.id AND NOT m.deleted AND m.created_at > now() - interval '3 days'
              GROUP BY r.id ORDER BY n DESC LIMIT 4`),
    db.one(`SELECT count(*)::int AS n FROM direct_messages WHERE recipient_id=$1 AND read_at IS NULL AND NOT deleted`, [me]),
    db.query(`SELECT * FROM users ORDER BY created_at DESC LIMIT 8`),
    db.one(`SELECT (SELECT count(*)::int FROM users) AS members, (SELECT count(*)::int FROM posts WHERE NOT deleted) AS posts`),
  ]);
  res.json({
    events, posts, rooms, unread: unread.n, counts,
    newMembers: newMembers.filter((u) => u.id !== me && isMember(u)).slice(0, 6).map(profileOf),
  });
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
  const kind = ['message', 'post', 'reply', 'dm', 'user'].includes(req.body.kind) ? req.body.kind : null;
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
         WHEN 'dm' THEN (SELECT body FROM direct_messages WHERE id=rp.target_id)
         WHEN 'user' THEN (SELECT 'Perfil / profile: ' || display_name || ' — ' || bio FROM users WHERE id=rp.target_id)
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
    const table = { message: 'messages', post: 'posts', reply: 'replies', dm: 'direct_messages' }[rp.kind];
    if (table) await db.query(`UPDATE ${table} SET deleted=true WHERE id=$1`, [rp.target_id]);
    if (rp.kind === 'user') await db.query(`UPDATE users SET bio='', avatar=NULL WHERE id=$1`, [rp.target_id]);
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
  socket.join(`user:${socket.data.user.id}`);
  db.query('UPDATE users SET last_seen=now() WHERE id=$1', [socket.data.user.id]).catch(() => {});

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
