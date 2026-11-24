// Database layer: real PostgreSQL when DATABASE_URL is set (Render),
// otherwise an embedded Postgres (PGlite) stored in ./data for local development.
const path = require('path');

let runQuery;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'es',
    role TEXT NOT NULL DEFAULT 'member',
    stripe_customer_id TEXT,
    subscription_status TEXT NOT NULL DEFAULT 'none',
    current_period_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id SERIAL PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    icon TEXT NOT NULL DEFAULT '💬',
    name_en TEXT NOT NULL,
    name_es TEXT NOT NULL,
    desc_en TEXT NOT NULL DEFAULT '',
    desc_es TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    deleted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS messages_room_idx ON messages(room_id, id DESC)`,
  `CREATE TABLE IF NOT EXISTS posts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL DEFAULT 'general',
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    deleted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_activity TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS replies (
    id SERIAL PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    deleted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    resolved BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
];

const ROOMS = [
  ['welcome', '👋', 'Welcome & introductions', 'Bienvenida y presentaciones', 'Say hi and tell us about your teen.', 'Saluda y cuéntanos sobre tu hijo o hija.'],
  ['meltdowns', '🌊', 'Meltdowns & hard days', 'Crisis y días difíciles', 'Support when things fall apart.', 'Apoyo cuando todo se desborda.'],
  ['school', '🎒', 'School, IEPs & teachers', 'Escuela, apoyos y maestros', 'Accommodations, meetings, homework.', 'Adaptaciones, reuniones, tareas.'],
  ['sensory', '🎧', 'Sensory life', 'Vida sensorial', 'Noise, textures, food, clothes.', 'Ruido, texturas, comida, ropa.'],
  ['sleep-food', '🌙', 'Sleep & food', 'Sueño y alimentación', 'Routines, picky eating, bedtime.', 'Rutinas, selectividad, hora de dormir.'],
  ['puberty', '🌱', 'Puberty & growing up', 'Pubertad y crecer', 'Body changes, hygiene, identity.', 'Cambios del cuerpo, higiene, identidad.'],
  ['friends', '🤝', 'Friendship & social life', 'Amistad y vida social', 'Friends, bullying, online life.', 'Amigos, acoso, vida en línea.'],
  ['family', '🏡', 'Siblings, partners & family', 'Hermanos, pareja y familia', 'Keeping the whole family well.', 'Cuidar a toda la familia.'],
  ['self-care', '💗', 'Mom self-care', 'Autocuidado de mamá', 'You matter too.', 'Tú también importas.'],
  ['wins', '🎉', 'Wins & good news', 'Logros y buenas noticias', 'Big and small victories.', 'Victorias grandes y pequeñas.'],
];

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
    runQuery = (text, params) => pool.query(text, params);
    console.log('DB: PostgreSQL');
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = path.join(__dirname, '..', 'data', 'pglite');
    require('fs').mkdirSync(path.dirname(dir), { recursive: true });
    const db = new PGlite(dir);
    await db.waitReady;
    runQuery = (text, params) => db.query(text, params);
    console.log('DB: embedded PGlite at', dir);
  }

  for (const stmt of SCHEMA) await runQuery(stmt);

  for (let i = 0; i < ROOMS.length; i++) {
    const [slug, icon, ne, ns, de, ds] = ROOMS[i];
    await runQuery(
      `INSERT INTO rooms (slug, icon, name_en, name_es, desc_en, desc_es, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (slug) DO NOTHING`,
      [slug, icon, ne, ns, de, ds, i]
    );
  }
}

async function query(text, params = []) {
  const res = await runQuery(text, params);
  return res.rows;
}

async function one(text, params = []) {
  const rows = await query(text, params);
  return rows[0] || null;
}

module.exports = { init, query, one };
