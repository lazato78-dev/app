// Círculo Azul — single-page frontend (vanilla JS, hash routing).
(() => {
  const state = {
    user: null,
    config: { paymentsEnabled: false, priceLabel: '', categories: [] },
    lang: null,
    socket: null,
    unread: 0,
    dmListener: null,
  };
  // Events & online meetings are built but hidden until courses start. Set to true to turn them on.
  const SHOW_EVENTS = false;
  const $main = document.getElementById('main');
  let cleanup = null;

  // ---------- i18n ----------
  function detectLang() {
    try { const s = localStorage.getItem('lang'); if (s === 'en' || s === 'es') return s; } catch {}
    return (navigator.language || 'es').toLowerCase().startsWith('en') ? 'en' : 'es';
  }
  state.lang = detectLang();
  const t = (k) => {
    const v = I18N[state.lang][k];
    return v === undefined ? (I18N.en[k] ?? k) : v;
  };
  const L = (obj) => obj[state.lang] || obj.en;
  const loc = () => (state.lang === 'en' ? 'en-US' : 'es-MX');
  function setLang(l) {
    state.lang = l;
    try { localStorage.setItem('lang', l); } catch {}
    document.documentElement.lang = l;
    if (state.user && state.user.lang !== l) api('PATCH', '/api/me', { lang: l }).catch(() => {});
    route();
  }

  // ---------- utils ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v; // only used with authored content
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error(data.error || 'error'); e.status = res.status; e.code = data.error; throw e; }
    return data;
  }
  function errText(e) {
    const k = 'err_' + (e && e.code);
    return I18N[state.lang][k] || t('err_generic');
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    const diff = (Date.now() - d) / 1000;
    if (diff < 45 && diff > -45) return t('just_now');
    const sameDay = new Date().toDateString() === d.toDateString();
    const time = d.toLocaleTimeString(loc(), { hour: 'numeric', minute: '2-digit' });
    return sameDay ? time : d.toLocaleDateString(loc(), { month: 'short', day: 'numeric' }) + ' ' + time;
  }
  function fmtDate(iso, opts) { return new Date(iso).toLocaleDateString(loc(), opts || { day: 'numeric', month: 'long', year: 'numeric' }); }
  function mount(...nodes) {
    $main.replaceChildren(...nodes.flat().filter(Boolean));
    $main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  const go = (hash) => { location.hash = hash; };
  const loading = () => mount(h('p', { class: 'muted' }, '…'));
  function toast(text, onClick) {
    const el = h('div', { class: 'toast', role: 'status', onclick: () => { el.remove(); onClick && onClick(); } }, text);
    document.body.append(el);
    setTimeout(() => el.remove(), 6000);
  }
  const AV_COLORS = ['#2f5597', '#d96c4f', '#4f8a68', '#7666b8', '#c58a1c', '#3a7d8c', '#b0567a'];
  function avatar(p, size) {
    const cls = 'avatar' + (size ? ' ' + size : '');
    if (p && p.avatar) return h('img', { class: cls, src: p.avatar, alt: '' });
    const name = (p && (p.displayName || p.display_name)) || '?';
    const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    const color = AV_COLORS[((p && p.id) || 0) % AV_COLORS.length];
    return h('span', { class: cls, style: `background:${color}`, 'aria-hidden': 'true' }, initials);
  }
  function readMinutes(html) {
    const words = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    return Math.max(2, Math.round(words / 200));
  }
  const pageHead = (title, lead, extra) =>
    h('div', { class: 'page-head' }, h('div', { class: 'row between' }, h('h1', { style: 'margin:0' }, title), extra || null), lead ? h('p', { style: 'margin-top:8px' }, lead) : null);

  // ---------- realtime ----------
  function ensureSocket() {
    if (!state.user || !state.user.isMember) return null;
    if (!state.socket) {
      state.socket = io({ withCredentials: true });
      state.socket.on('dm', (m) => {
        if (state.dmListener && state.dmListener(m)) return;
        if (m.recipient_id === state.user.id) {
          state.unread += 1;
          updateBadge();
          toast(`${t('new_message_from')} ${m.sender_name}`, () => go('#/messages/' + m.sender_id));
        }
      });
    }
    return state.socket;
  }
  function updateBadge() {
    const b = document.getElementById('dmBadge');
    if (b) b.textContent = state.unread > 0 ? String(state.unread) : '';
  }
  async function refreshUnread() {
    if (!state.user || !state.user.isMember) return;
    try { const r = await api('GET', '/api/dms/unread'); state.unread = r.unread; updateBadge(); } catch {}
  }

  // ---------- chrome ----------
  function renderChrome() {
    const loggedIn = Boolean(state.user);
    document.body.classList.toggle('app', loggedIn);
    document.body.classList.remove('menu-open');
    const cur = location.hash || '#/';

    const langToggle = h('div', { class: 'lang-toggle', role: 'group', 'aria-label': 'Language' },
      h('button', { class: state.lang === 'es' ? 'on' : '', onclick: () => setLang('es'), 'aria-pressed': String(state.lang === 'es') }, 'ES'),
      h('button', { class: state.lang === 'en' ? 'on' : '', onclick: () => setLang('en'), 'aria-pressed': String(state.lang === 'en') }, 'EN'));
    const top = document.getElementById('topActions');
    if (loggedIn) {
      top.replaceChildren(langToggle, h('a', { href: '#/account', class: 'link', title: t('nav_account') }, avatar(state.user, 'sm')));
    } else {
      top.replaceChildren(
        h('a', { href: '#/learn', class: 'link hide-sm' }, t('nav_learn')),
        h('a', { href: '#/resources', class: 'link hide-sm' }, t('nav_resources')),
        h('a', { href: '#/login', class: 'link' }, t('nav_login')),
        h('a', { href: '#/register', class: 'btn small' }, t('nav_join')),
        langToggle);
    }

    const side = document.getElementById('sidebar');
    if (loggedIn) {
      const link = (href, ic, label, badge) => {
        const active = href === '#/home' ? (cur === '#/home' || cur === '#/') : cur.startsWith(href);
        return h('a', { href, class: 'side-link' + (active ? ' active' : '') },
          h('span', { class: 'ic', 'aria-hidden': 'true' }, ic), label, badge || null);
      };
      side.replaceChildren(
        link('#/home', '🏠', t('nav_home')),
        h('div', { class: 'side-sec' }, t('sec_learn')),
        link('#/learn', '📘', t('nav_learn')),
        link('#/resources', '🤝', t('nav_resources')),
        h('div', { class: 'side-sec' }, t('sec_community')),
        link('#/rooms', '💬', t('nav_rooms')),
        link('#/forum', '📝', t('nav_forum')),
        SHOW_EVENTS ? link('#/events', '📅', t('nav_events')) : null,
        link('#/members', '👩‍👧', t('nav_members')),
        link('#/messages', '✉️', t('nav_messages'), h('span', { class: 'badge', id: 'dmBadge' }, state.unread > 0 ? String(state.unread) : '')),
        h('div', { class: 'side-sec' }, t('sec_you')),
        link('#/account', '⚙️', t('nav_account')),
        h('div', { class: 'side-crisis' }, t('footer_crisis')));
    } else {
      side.replaceChildren();
    }
    const btn = document.getElementById('menuBtn');
    btn.textContent = '☰ ' + t('menu');
    btn.setAttribute('aria-expanded', 'false');

    document.getElementById('footer').replaceChildren(
      h('p', {}, t('footer_disclaimer')),
      h('p', {}, t('footer_crisis')),
      h('p', {}, h('a', { href: '#/learn/guidelines' }, t('guidelines')), ' · ', h('a', { href: '#/resources' }, t('nav_resources')), ' · © ' + new Date().getFullYear() + ' Círculo Azul'));
  }
  document.getElementById('menuBtn').addEventListener('click', (e) => {
    const open = document.body.classList.toggle('menu-open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });
  document.getElementById('scrim').addEventListener('click', () => document.body.classList.remove('menu-open'));

  // ---------- gates ----------
  function needUser() {
    if (state.user) return false;
    mount(h('div', { class: 'card narrow center' },
      h('p', {}, t('login_needed')),
      h('div', { class: 'row', style: 'justify-content:center' },
        h('a', { class: 'btn', href: '#/login' }, t('nav_login')),
        h('a', { class: 'btn secondary', href: '#/register' }, t('nav_join')))));
    return true;
  }
  function needMember() {
    if (needUser()) return true;
    if (state.user.isMember) return false;
    mount(h('div', { class: 'card narrow center' },
      h('h2', {}, t('members_only')),
      h('a', { class: 'btn', href: '#/join' }, t('members_only_btn'))));
    return true;
  }

  // ---------- landing ----------
  function heroArt() {
    const d = document.createElement('div');
    d.innerHTML = `<svg class="hero-art" viewBox="0 0 400 360" role="img" aria-label="">
      <circle cx="200" cy="180" r="150" fill="var(--primary-soft)"/>
      <circle cx="200" cy="180" r="150" fill="none" stroke="var(--primary)" stroke-width="22"/>
      <circle cx="318" cy="70" r="26" fill="var(--sun-soft)"/><circle cx="76" cy="292" r="18" fill="var(--sage-soft)"/>
      <circle cx="168" cy="140" r="30" fill="var(--accent)"/>
      <path d="M118 262c0-40 22-72 50-72s50 32 50 72z" fill="var(--accent)"/>
      <circle cx="240" cy="156" r="24" fill="var(--primary)"/>
      <path d="M200 262c0-34 18-60 40-60s40 26 40 60z" fill="var(--primary)"/>
      <path d="M205 214c-12 8-20 20-22 32" stroke="var(--accent)" stroke-width="14" stroke-linecap="round" fill="none"/>
      <path d="M296 112c6-10 18-10 22 0 4-10 16-10 22 0 4 12-22 26-22 26s-26-14-22-26z" fill="var(--accent)" opacity=".85"/>
    </svg>`;
    return d.firstElementChild;
  }
  function guideCard(g, i) {
    const c = L(g);
    return h('a', { class: 'card guide-card', href: '#/learn/' + g.slug },
      h('span', { class: 'gic tone-' + (i % 6), 'aria-hidden': 'true' }, g.icon),
      h('h3', {}, c.title),
      h('p', {}, c.summary),
      h('div', { class: 'meta' }, h('span', { class: 'pill' }, readMinutes(c.html) + ' ' + t('min_read'))));
  }
  function pageLanding() {
    const price = state.config.paymentsEnabled ? (state.config.priceLabel || '') : t('price_free');
    const features = [['💬', 'f_chat'], ['📝', 'f_forum'], ['✉️', 'f_dm'], ['👩‍👧', 'f_moms'], ['📘', 'f_learn'], ['🤝', 'f_res']];
    const preview = ['understanding-love', 'helping', 'adulthood', 'diagnosis', 'mental-health', 'spectrum']
      .map((s) => CONTENT.find((g) => g.slug === s)).filter(Boolean);
    mount(
      h('section', { class: 'hero' },
        h('div', {},
          h('span', { class: 'kicker' }, t('hero_kicker')),
          h('h1', {}, t('hero_title')),
          h('p', { class: 'lead' }, t('hero_lead')),
          h('div', { class: 'row' },
            h('a', { class: 'btn', href: '#/register' }, t('hero_cta')),
            h('a', { class: 'btn secondary', href: '#/learn' }, t('hero_cta2')))),
        heroArt()),
      h('section', { class: 'section' },
        h('h2', {}, t('what_title')),
        h('div', { class: 'grid' }, features.map(([ic, k], i) =>
          h('div', { class: 'card feature' },
            h('span', { class: 'ic tone-' + i, 'aria-hidden': 'true' }, ic),
            h('div', {}, h('h3', {}, t(k + '_t')), h('p', {}, t(k + '_d'))))))),
      h('section', { class: 'section' },
        h('h2', {}, t('guides_preview')),
        h('div', { class: 'grid' }, preview.map(guideCard)),
        h('p', { class: 'center', style: 'margin-top:16px' }, h('a', { class: 'btn ghost', href: '#/learn' }, t('see_all_guides')))),
      h('section', { class: 'section' },
        h('h2', {}, t('how_title')),
        h('div', { class: 'grid steps' }, [1, 2, 3].map((n) =>
          h('div', { class: 'card step' }, h('h3', {}, t(`how_${n}t`)), h('p', { class: 'muted', style: 'margin:0' }, t(`how_${n}d`)))))),
      h('section', { class: 'section' },
        h('div', { class: 'card price-card' },
          h('h2', {}, t('price_title')),
          price ? h('p', { class: 'price' }, price) : null,
          h('ul', { class: 'checklist' }, t('join_includes').map((x) => h('li', {}, x))),
          h('p', { class: 'muted small' }, t('price_note')),
          h('a', { class: 'btn accent', href: '#/register' }, t('hero_cta')))),
      h('section', { class: 'section', style: 'max-width:760px;margin-left:auto;margin-right:auto' },
        h('h2', {}, t('faq_title')),
        t('faq').map(([q, a]) => h('details', { class: 'faq' }, h('summary', {}, q), h('p', {}, a)))),
    );
  }

  // ---------- auth ----------
  function pageAuth(mode) {
    if (state.user) return go('#/home');
    const isReg = mode === 'register';
    const err = h('p', { class: 'error', role: 'alert' });
    const form = h('form', { class: 'stack' },
      isReg ? h('label', {}, t('display_name'), h('input', { name: 'displayName', required: true, maxlength: 40, autocomplete: 'nickname' }), h('span', { class: 'muted small' }, t('display_name_hint'))) : null,
      h('label', {}, t('email'), h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
      h('label', {}, t('password'), h('input', { name: 'password', type: 'password', required: true, minlength: isReg ? 8 : null, autocomplete: isReg ? 'new-password' : 'current-password' }),
        isReg ? h('span', { class: 'muted small' }, t('password_hint')) : null),
      err,
      h('button', { class: 'btn', type: 'submit' }, isReg ? t('btn_register') : t('btn_login')),
      isReg ? h('p', { class: 'muted small', style: 'margin:0' }, t('agree'), ' ', h('a', { href: '#/learn/guidelines' }, t('guidelines'))) : null,
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const fd = Object.fromEntries(new FormData(form));
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        const { user } = await api('POST', isReg ? '/api/register' : '/api/login', { ...fd, lang: state.lang });
        state.user = user;
        if (!isReg && user.lang && user.lang !== state.lang) { state.lang = user.lang; try { localStorage.setItem('lang', user.lang); } catch {} }
        ensureSocket(); refreshUnread();
        go(user.isMember ? (isReg ? '#/account?welcome=1' : '#/home') : '#/join');
      } catch (ex) { err.textContent = errText(ex); btn.disabled = false; }
    });
    mount(h('div', { class: 'card narrow', style: 'margin-top:20px' },
      h('h1', { style: 'font-size:1.9rem' }, isReg ? t('register_title') : t('login_title')),
      form,
      h('p', { class: 'center small', style: 'margin:16px 0 0' },
        isReg ? t('have_account') : t('no_account'), ' ',
        h('a', { href: isReg ? '#/login' : '#/register' }, isReg ? t('nav_login') : t('nav_join')))));
  }

  function pageJoin() {
    if (needUser()) return;
    if (state.user.isMember) return go('#/home');
    const err = h('p', { class: 'error', role: 'alert' });
    const btn = h('button', { class: 'btn accent' }, t('join_btn'));
    btn.addEventListener('click', async () => {
      btn.disabled = true; err.textContent = t('join_redirect');
      try { const { url } = await api('POST', '/api/billing/checkout'); location.href = url; }
      catch (ex) { err.textContent = errText(ex); btn.disabled = false; }
    });
    mount(h('div', { class: 'card price-card' },
      h('h1', {}, t('join_title')),
      h('p', { class: 'muted' }, t('join_lead')),
      state.config.priceLabel ? h('p', { class: 'price' }, state.config.priceLabel) : null,
      h('ul', { class: 'checklist' }, t('join_includes').map((x) => h('li', {}, x))),
      h('div', {}, btn), err,
      h('p', { class: 'muted small' }, t('price_note'))));
  }

  // ---------- member home ----------
  async function pageHome() {
    if (!state.user) return pageLanding();
    if (!state.user.isMember) return go('#/join');
    loading();
    let d;
    try { d = await api('GET', '/api/home'); } catch (ex) { return mount(h('p', { class: 'error' }, errText(ex))); }
    const u = state.user;
    const dayIdx = Math.floor(Date.now() / 86400000);
    const guides = CONTENT.filter((g) => g.slug !== 'guidelines');
    const guide = guides[dayIdx % guides.length];
    const tip = t('selfcare_tips')[dayIdx % t('selfcare_tips').length];
    const profileEmpty = !u.bio && !u.avatar && !u.teenInfo;

    const eventsCard = h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, t('upcoming_events')), h('a', { href: '#/events', class: 'small' }, t('nav_events') + ' →')),
      d.events.length
        ? d.events.map((e) => {
            const dt = new Date(e.starts_at);
            return h('a', { class: 'list-link', href: '#/events' },
              h('span', { class: 'date-badge' }, h('b', {}, dt.getDate()), h('span', {}, dt.toLocaleDateString(loc(), { month: 'short' }))),
              h('div', {}, h('div', { class: 'ttl' }, e.title), h('div', { class: 'muted small' }, dt.toLocaleTimeString(loc(), { weekday: 'long', hour: 'numeric', minute: '2-digit' }))));
          })
        : h('p', { class: 'muted', style: 'margin:12px 0 0' }, t('no_events')));

    const forumCard = h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, t('latest_forum')), h('a', { href: '#/forum', class: 'small' }, t('nav_forum') + ' →')),
      d.posts.length
        ? d.posts.map((p) => h('a', { class: 'list-link', href: '#/forum/' + p.id },
            h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'ttl' }, p.title), h('div', { class: 'muted small' }, p.display_name + ' · ' + fmtTime(p.last_activity))),
            h('span', { class: 'pill' }, `${p.reply_count} ${p.reply_count === 1 ? t('reply_one') : t('replies')}`)))
        : h('p', { class: 'muted', style: 'margin:12px 0 0' }, t('no_posts'), ' ', h('a', { href: '#/forum/new' }, t('new_post'))));

    const roomsCard = h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, t('active_rooms')), h('a', { href: '#/rooms', class: 'small' }, t('nav_rooms') + ' →')),
      d.rooms.length
        ? d.rooms.map((r) => h('a', { class: 'list-link', href: '#/rooms/' + r.slug }, h('span', { style: 'font-size:1.3rem' }, r.icon), h('span', { class: 'ttl' }, state.lang === 'en' ? r.name_en : r.name_es)))
        : h('p', { class: 'muted', style: 'margin:12px 0 0' }, t('quiet_rooms'), ' ', h('a', { href: '#/rooms/welcome' }, '👋')));

    const guideCardEl = h('section', { class: 'card' },
      h('span', { class: 'pill sage' }, t('guide_of_day')),
      h('h2', { style: 'margin:10px 0 6px' }, guide.icon + ' ' + L(guide).title),
      h('p', { class: 'muted' }, L(guide).summary),
      h('a', { class: 'btn small', href: '#/learn/' + guide.slug }, t('read_guide')));

    const momsCard = d.newMembers.length ? h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, t('new_moms')), h('a', { href: '#/members', class: 'small' }, t('nav_members') + ' →')),
      h('div', { class: 'avatars-row', style: 'margin-top:14px' }, d.newMembers.map((m) =>
        h('a', { href: '#/u/' + m.id }, avatar(m), m.displayName)))) : null;

    mount(
      h('section', { class: 'card welcome-banner' },
        h('h1', { style: 'margin-bottom:6px' }, `${t('hello')}, ${u.displayName} 💙`),
        h('p', { style: 'margin:0' }, t('home_lead')),
        h('div', { class: 'row', style: 'margin-top:14px' },
          h('span', { class: 'pill primary' }, `${d.counts.members} ${t('members_count')}`),
          h('span', { class: 'pill primary' }, `${d.counts.posts} ${d.counts.posts === 1 ? t('posts_count_one') : t('posts_count')}`),
          d.unread ? h('a', { class: 'pill accent', href: '#/messages', style: 'text-decoration:none' }, `${d.unread} ${d.unread === 1 ? t('unread_msgs_one') : t('unread_msgs')}`) : null)),
      profileEmpty ? h('div', { class: 'notice warm row between', style: 'margin-top:16px' }, h('span', {}, t('complete_profile')), h('a', { class: 'btn small', href: '#/account' }, t('complete_profile_btn'))) : null,
      h('div', { class: 'grid-2', style: 'margin-top:18px' }, SHOW_EVENTS ? eventsCard : null, forumCard, roomsCard, guideCardEl, momsCard,
        h('section', { class: 'card', style: 'background:var(--accent-soft);border:0' }, h('h3', {}, '💗 ' + t('selfcare_t')), h('p', { style: 'margin:0;font-size:1.05rem' }, tip))),
    );
  }

  // ---------- learn ----------
  const GUIDE_ROOM = { diagnosis: 'new-diagnosis', 'mental-health': 'mental-health', adulthood: 'adulthood', 'sensory-meltdowns': 'meltdowns',
    'self-care': 'self-care', 'teen-years': 'puberty', helping: 'meltdowns', communication: 'school', 'understanding-love': 'family', 'love-languages': 'wins', spectrum: 'new-diagnosis', therapies: 'mental-health' };
  function pageLearn(slug) {
    if (!slug) {
      mount(pageHead(t('learn_title'), t('learn_lead')), h('div', { class: 'grid' }, CONTENT.map(guideCard)));
      return;
    }
    const idx = CONTENT.findIndex((x) => x.slug === slug);
    if (idx < 0) return go('#/learn');
    const g = CONTENT[idx]; const c = L(g);
    const prev = CONTENT[idx - 1]; const next = CONTENT[idx + 1];
    const toc = h('nav', { class: 'toc', 'aria-label': t('learn_title') },
      CONTENT.map((it) => h('a', { href: '#/learn/' + it.slug, class: it.slug === slug ? 'active' : '' }, it.icon + ' ' + L(it).title)));
    const room = GUIDE_ROOM[slug];
    mount(h('div', { class: 'learn-layout' }, toc,
      h('article', { class: 'article' },
        h('p', { class: 'no-print', style: 'margin:0 0 10px' }, h('a', { href: '#/learn' }, '← ' + t('learn_title'))),
        h('div', { class: 'article-head' },
          h('span', { class: 'gic tone-' + (idx % 6), 'aria-hidden': 'true' }, g.icon),
          h('h1', {}, c.title),
          h('div', { class: 'row' }, h('span', { class: 'pill' }, readMinutes(c.html) + ' ' + t('min_read')),
            h('button', { class: 'btn ghost small no-print', onclick: () => window.print() }, '🖨 ' + t('print')))),
        c.keyPoints ? h('div', { class: 'keypoints' }, h('h3', {}, '✨ ' + t('key_points')), h('ul', {}, c.keyPoints.map((k) => h('li', {}, k)))) : null,
        h('div', { html: c.html }),
        room && state.user && state.user.isMember ? h('div', { class: 'notice no-print', style: 'margin-top:24px' }, '💬 ', h('a', { href: '#/rooms/' + room }, t('related_room'))) : null,
        h('nav', { class: 'article-nav' },
          prev ? h('a', { class: 'btn secondary small', href: '#/learn/' + prev.slug }, t('prev')) : h('span'),
          next ? h('a', { class: 'btn small', href: '#/learn/' + next.slug }, t('next')) : h('span')))));
  }

  // ---------- resources ----------
  function pageResources() {
    mount(
      pageHead(t('res_title'), t('res_lead')),
      RESOURCES.map((sec, si) => {
        const s = L(sec);
        return h('section', { class: 'res-sec', id: 'res-' + sec.id },
          h('h2', {}, h('span', { class: 'room-icon tone-' + (si % 6), 'aria-hidden': 'true' }, sec.icon), s.title),
          h('p', { class: 'muted' }, s.intro),
          h('div', { class: 'grid' }, sec.items.map((it) =>
            h('div', { class: 'card res-item flat' },
              h('h3', {}, it.name),
              it.where ? h('span', { class: 'pill', style: 'align-self:flex-start' }, it.where) : null,
              h('p', { class: 'muted small', style: 'margin:0' }, it[state.lang] || it.en),
              (it.phone || it.url) ? h('div', { class: 'row' },
                it.phone ? h('a', { class: 'btn small accent', href: 'tel:' + it.phone.replace(/[^\d+]/g, '') }, '📞 ' + it.phone) : null,
                it.url ? h('a', { class: 'btn small secondary', href: it.url, target: '_blank', rel: 'noopener noreferrer' }, t('visit') + ' ↗') : null) : null))));
      }),
      h('p', { class: 'muted small' }, t('res_note')));
  }

  // ---------- rooms ----------
  async function pageRooms() {
    if (needMember()) return;
    loading();
    try {
      const { rooms } = await api('GET', '/api/rooms');
      mount(
        pageHead(t('rooms_title'), t('rooms_lead')),
        h('div', { class: 'grid' }, rooms.map((r, i) => {
          const info = ROOM_INFO[r.slug];
          return h('a', { class: 'card room-card', href: '#/rooms/' + r.slug },
            h('span', { class: 'room-icon tone-' + (i % 6), 'aria-hidden': 'true' }, r.icon),
            h('div', {},
              h('h3', {}, state.lang === 'en' ? r.name_en : r.name_es),
              h('p', { class: 'muted small' }, info ? L(info).intro : (state.lang === 'en' ? r.desc_en : r.desc_es)),
              r.last_message_at ? h('span', { class: 'pill', style: 'margin-top:8px' }, '💬 ' + fmtTime(r.last_message_at)) : null));
        })));
    } catch (ex) { mount(h('p', { class: 'error' }, errText(ex))); }
  }

  function roomInfoPanel(slug, onStarter) {
    const info = ROOM_INFO[slug];
    if (!info) return null;
    const c = L(info);
    const guide = CONTENT.find((g) => g.slug === info.guide);
    return h('aside', { class: 'card room-info room-info-panel' },
      h('details', { class: 'room-details', open: true },
        h('summary', {}, 'ℹ️ ' + t('room_info')),
        h('p', { style: 'margin:10px 0 0' }, c.intro),
        h('h3', {}, t('tips')),
        h('ul', {}, c.tips.map((x) => h('li', {}, x))),
        h('h3', {}, t('starters')),
        c.starters.map((s) => h('div', { class: 'starter' }, h('span', {}, s), h('button', { class: 'btn ghost small', onclick: () => onStarter(s) }, t('use_starter')))),
        guide ? h('p', { style: 'margin:16px 0 0' }, h('a', { href: '#/learn/' + guide.slug }, '📘 ' + t('related_guide') + ': ' + L(guide).title)) : null));
  }

  async function pageChat(slug) {
    if (needMember()) return;
    let data;
    try { data = await api('GET', `/api/rooms/${encodeURIComponent(slug)}/messages`); }
    catch (ex) { return mount(h('p', { class: 'error' }, errText(ex))); }
    const { room } = data;
    const log = h('div', { class: 'chat-log', 'aria-live': 'polite' });
    const presence = h('span', { class: 'pill sage' }, '');
    const status = h('span', { class: 'muted small' });
    const input = h('textarea', { placeholder: t('type_message'), maxlength: 2000, 'aria-label': t('type_message'), rows: 1 });
    const err = h('span', { class: 'error small' });
    let oldestId = null;

    function msgEl(m) {
      const mine = m.user_id === state.user.id;
      const tools = h('span', { class: 'tools' });
      if (mine || state.user.role === 'admin') {
        tools.append(h('button', { class: 'iconbtn', onclick: () => { if (confirm(t('confirm_delete'))) state.socket.emit('delete', m.id); } }, t('delete')));
      }
      if (!mine) tools.append(h('button', { class: 'iconbtn', onclick: () => report('message', m.id) }, t('report')));
      const p = { id: m.user_id, displayName: m.display_name, avatar: m.avatar };
      return h('div', { class: 'msg' + (mine ? ' mine' : ''), 'data-id': m.id, tabindex: 0 },
        mine ? null : h('a', { href: '#/u/' + m.user_id, 'aria-label': m.display_name }, avatar(p, 'sm')),
        h('div', { class: 'bubble' },
          h('div', {}, h('a', { class: 'who', href: '#/u/' + m.user_id }, m.display_name), h('span', { class: 'when' }, fmtTime(m.created_at)), ' ', tools),
          h('div', { class: 'body' }, m.body)));
    }
    function addMessages(msgs, prepend) {
      if (!msgs.length) return;
      const nodes = msgs.map(msgEl);
      if (prepend) {
        const prevH = log.scrollHeight;
        const anchor = log.querySelector('.msg');
        nodes.forEach((n) => log.insertBefore(n, anchor));
        log.scrollTop = log.scrollHeight - prevH;
      } else {
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        log.querySelector('.empty')?.remove();
        log.append(...nodes);
        if (atBottom || msgs.some((m) => m.user_id === state.user.id)) log.scrollTop = log.scrollHeight;
      }
      oldestId = Math.min(oldestId ?? Infinity, ...msgs.map((m) => m.id));
    }
    const olderBtn = h('button', { class: 'btn ghost small', style: 'align-self:center' }, t('load_older'));
    olderBtn.addEventListener('click', async () => {
      const r = await api('GET', `/api/rooms/${encodeURIComponent(slug)}/messages?before=${oldestId}`);
      addMessages(r.messages, true);
      if (r.messages.length < 50) olderBtn.remove();
    });
    if (data.messages.length >= 50) log.append(olderBtn);
    if (!data.messages.length) log.append(h('p', { class: 'muted center empty' }, t('no_messages')));

    const form = h('form', { class: 'chat-form' }, input, h('button', { class: 'btn', type: 'submit' }, t('send')));
    const send = () => {
      const body = input.value.trim();
      if (!body) return;
      err.textContent = '';
      state.socket.emit('message', { body }, (res) => { if (res?.error) err.textContent = errText({ code: res.error }); });
      input.value = ''; input.style.height = '';
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; });
    const useStarter = (s) => { input.value = s; input.focus(); };

    mount(
      h('p', { style: 'margin:0 0 10px' }, h('a', { href: '#/rooms' }, t('back_rooms'))),
      h('div', { class: 'chat-wrap' },
        h('section', { class: 'card chat' },
          h('div', { class: 'chat-head' },
            h('span', { style: 'font-size:1.4rem', 'aria-hidden': 'true' }, room.icon),
            h('h2', { style: 'margin:0;font-size:1.2rem' }, state.lang === 'en' ? room.name_en : room.name_es),
            presence, status, err),
          log, form),
        roomInfoPanel(slug, useStarter)));
    addMessages(data.messages, false);
    log.scrollTop = log.scrollHeight;

    const sock = ensureSocket();
    const join = () => sock.emit('join', slug);
    const onMsg = (m) => addMessages([m], false);
    const onDel = ({ id }) => log.querySelector(`.msg[data-id="${id}"]`)?.remove();
    const onPres = (p) => { if (p.slug === slug) presence.textContent = `● ${p.count} ${t('online')}`; };
    const onDisc = () => { status.textContent = t('disconnected'); };
    const onConn = () => { status.textContent = ''; join(); };
    sock.on('message', onMsg); sock.on('deleted', onDel); sock.on('presence', onPres);
    sock.on('disconnect', onDisc); sock.on('connect', onConn);
    if (sock.connected) join();
    cleanup = () => {
      sock.off('message', onMsg); sock.off('deleted', onDel); sock.off('presence', onPres);
      sock.off('disconnect', onDisc); sock.off('connect', onConn);
      sock.emit('join', '__none__');
    };
    if (window.matchMedia('(min-width: 900px)').matches) input.focus();
  }

  async function report(kind, id) {
    const reason = prompt(t('report_reason'));
    if (reason === null) return;
    try { await api('POST', '/api/reports', { kind, targetId: id, reason }); alert(t('reported')); }
    catch (ex) { alert(errText(ex)); }
  }

  // ---------- forum ----------
  async function pageForum(cat) {
    if (needMember()) return;
    const cats = state.config.categories;
    let posts;
    try { ({ posts } = await api('GET', '/api/posts' + (cat ? `?category=${encodeURIComponent(cat)}` : ''))); }
    catch (ex) { return mount(h('p', { class: 'error' }, errText(ex))); }
    const catName = (c) => t('cat')[c] || c;
    mount(
      pageHead(t('forum_title'), t('forum_lead'), h('a', { class: 'btn', href: '#/forum/new' }, '+ ' + t('new_post'))),
      h('div', { class: 'filters' },
        h('button', { class: !cat ? 'on' : '', onclick: () => go('#/forum') }, t('all')),
        cats.map((c) => h('button', { class: cat === c ? 'on' : '', onclick: () => go('#/forum?c=' + c) }, catName(c)))),
      posts.length
        ? h('div', { class: 'post-list' }, posts.map((p) =>
            h('a', { class: 'card post-item', href: '#/forum/' + p.id },
              h('div', { style: 'min-width:0' },
                h('h3', { style: 'margin:0 0 4px' }, p.title),
                h('span', { class: 'muted small' }, p.display_name + ' · ' + fmtTime(p.created_at) + ' '), h('span', { class: 'pill' }, catName(p.category))),
              h('div', { class: 'muted small', style: 'white-space:nowrap' }, `💬 ${p.reply_count}`))))
        : h('div', { class: 'card empty-state' }, h('p', {}, t('no_posts')), h('a', { class: 'btn', href: '#/forum/new' }, '+ ' + t('new_post'))));
  }

  function pageNewPost() {
    if (needMember()) return;
    const err = h('p', { class: 'error', role: 'alert' });
    const form = h('form', { class: 'stack' },
      h('label', {}, t('title'), h('input', { name: 'title', required: true, maxlength: 150 })),
      h('label', {}, t('category'), h('select', { name: 'category' }, state.config.categories.map((c) => h('option', { value: c }, t('cat')[c] || c)))),
      h('label', {}, t('message'), h('textarea', { name: 'body', required: true, maxlength: 5000, rows: 8 })),
      err,
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, t('publish')), h('a', { class: 'btn secondary', href: '#/forum' }, '✕')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      try { const { id } = await api('POST', '/api/posts', Object.fromEntries(new FormData(form))); go('#/forum/' + id); }
      catch (ex) { err.textContent = errText(ex); btn.disabled = false; }
    });
    mount(h('p', {}, h('a', { href: '#/forum' }, t('back_forum'))), h('div', { class: 'card' }, h('h1', {}, t('new_post')), form));
  }

  async function pagePost(id) {
    if (needMember()) return;
    let data;
    try { data = await api('GET', '/api/posts/' + encodeURIComponent(id)); }
    catch (ex) { return mount(h('p', {}, h('a', { href: '#/forum' }, t('back_forum'))), h('p', { class: 'error' }, errText(ex))); }
    const { post, replies } = data;
    const canDel = (uid) => uid === state.user.id || state.user.role === 'admin';
    const actions = (kind, item) => h('span', { class: 'row', style: 'gap:4px;display:inline-flex' },
      canDel(item.user_id) ? h('button', { class: 'iconbtn', onclick: async () => {
        if (!confirm(t('confirm_delete'))) return;
        await api('DELETE', (kind === 'post' ? '/api/posts/' : '/api/replies/') + item.id);
        if (kind === 'post') go('#/forum'); else pagePost(id);
      } }, t('delete')) : null,
      item.user_id !== state.user.id ? h('button', { class: 'iconbtn', onclick: () => report(kind, item.id) }, t('report')) : null);
    const author = (uid, name, when) => h('a', { class: 'author', href: '#/u/' + uid },
      avatar({ id: uid, displayName: name }, 'sm'), h('span', {}, h('strong', {}, name), h('span', { class: 'muted small' }, ' · ' + fmtTime(when))));
    const err = h('p', { class: 'error', role: 'alert' });
    const ta = h('textarea', { name: 'body', placeholder: t('write_reply'), maxlength: 5000, required: true, 'aria-label': t('write_reply') });
    const form = h('form', { class: 'stack', style: 'margin-top:16px' }, ta, err, h('div', {}, h('button', { class: 'btn', type: 'submit' }, t('reply'))));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('POST', `/api/posts/${post.id}/replies`, { body: ta.value }); pagePost(id); }
      catch (ex) { err.textContent = errText(ex); }
    });
    mount(
      h('p', {}, h('a', { href: '#/forum' }, t('back_forum'))),
      h('article', { class: 'card' },
        h('span', { class: 'pill' }, t('cat')[post.category] || post.category),
        h('h1', { style: 'margin-top:10px' }, post.title),
        h('div', { class: 'row between' }, author(post.user_id, post.display_name, post.created_at), actions('post', post)),
        h('div', { class: 'post-body', style: 'margin-top:16px' }, post.body)),
      h('section', { class: 'card', style: 'margin-top:16px' },
        h('h2', {}, `${replies.length} ${replies.length === 1 ? t('reply_one') : t('replies')}`),
        replies.map((r) => h('div', { class: 'reply' },
          h('div', { class: 'row between' }, author(r.user_id, r.display_name, r.created_at), actions('reply', r)),
          h('div', { class: 'post-body', style: 'margin-top:8px' }, r.body))),
        form));
  }

  // ---------- members & profiles ----------
  async function pageMembers() {
    if (needMember()) return;
    const q = h('input', { type: 'search', placeholder: t('search'), 'aria-label': t('search'), style: 'max-width:360px' });
    const grid = h('div', { class: 'grid' });
    async function load() {
      try {
        const { members } = await api('GET', '/api/members?q=' + encodeURIComponent(q.value.trim()));
        const list = members.filter((m) => m.id !== state.user.id);
        grid.replaceChildren(...(list.length ? list.map((m) =>
          h('a', { class: 'card member-card', href: '#/u/' + m.id },
            avatar(m, 'lg'),
            h('h3', {}, m.displayName, m.role === 'admin' ? ' ' : null, m.role === 'admin' ? h('span', { class: 'pill primary' }, t('moderator')) : null),
            m.location ? h('p', { class: 'muted small' }, '📍 ' + m.location) : null,
            m.teenInfo ? h('p', { class: 'small' }, m.teenInfo) : null)) : [h('p', { class: 'muted' }, t('no_members'))]));
      } catch (ex) { grid.replaceChildren(h('p', { class: 'error' }, errText(ex))); }
    }
    let timer;
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
    mount(pageHead(t('members_title'), t('members_lead')), h('div', { style: 'margin-bottom:18px' }, q), grid);
    load();
  }

  async function pageProfile(id) {
    if (needMember()) return;
    if (String(id) === String(state.user.id)) return go('#/account');
    let d;
    try { d = await api('GET', '/api/users/' + encodeURIComponent(id)); }
    catch (ex) { return mount(h('p', { class: 'error' }, errText(ex))); }
    const p = d.profile;
    const blockBtn = h('button', { class: 'btn danger small', onclick: async () => {
      if (d.blockedByMe) await api('DELETE', '/api/blocks/' + p.id);
      else { if (!confirm(t('confirm_block'))) return; await api('POST', '/api/blocks/' + p.id); }
      pageProfile(id);
    } }, d.blockedByMe ? t('unblock') : t('block'));
    const interests = p.interests ? p.interests.split(',').map((s) => s.trim()).filter(Boolean) : [];
    mount(
      h('p', {}, h('a', { href: '#/members' }, '← ' + t('nav_members'))),
      h('section', { class: 'card' },
        h('div', { class: 'profile-head' },
          avatar(p, 'lg'),
          h('div', { style: 'flex:1;min-width:200px' },
            h('h1', { style: 'margin:0' }, p.displayName),
            h('div', { class: 'row', style: 'margin-top:6px' },
              p.role === 'admin' ? h('span', { class: 'pill primary' }, t('moderator')) : null,
              p.location ? h('span', { class: 'muted' }, '📍 ' + p.location) : null,
              h('span', { class: 'muted small' }, t('member_since') + ' ' + fmtDate(p.memberSince, { month: 'long', year: 'numeric' })))),
          h('div', { class: 'row' },
            p.allowDms && !d.blockedByMe ? h('a', { class: 'btn', href: '#/messages/' + p.id }, '✉️ ' + t('send_message')) : null)),
        d.blockedByMe ? h('p', { class: 'notice warm', style: 'margin:16px 0 0' }, t('blocked_note')) : null,
        p.teenInfo ? h('div', { style: 'margin-top:18px' }, h('h3', {}, t('teen')), h('p', {}, p.teenInfo)) : null,
        p.bio ? h('div', {}, h('h3', {}, t('about_me')), h('p', { class: 'post-body' }, p.bio)) : null,
        interests.length ? h('div', {}, h('h3', {}, t('interests')), h('div', { class: 'chips' }, interests.map((x) => h('span', { class: 'pill sage' }, x)))) : null,
        d.posts.length ? h('div', { style: 'margin-top:14px' }, h('h3', {}, t('her_posts')), d.posts.map((x) => h('a', { class: 'list-link', href: '#/forum/' + x.id }, h('span', { class: 'ttl' }, x.title)))) : null,
        h('div', { class: 'row', style: 'margin-top:18px' }, blockBtn, h('button', { class: 'btn danger small', onclick: () => report('user', p.id) }, t('report_profile')))));
  }

  // ---------- messages ----------
  async function pageMessages(otherId) {
    if (needMember()) return;
    let convs;
    try { ({ conversations: convs } = await api('GET', '/api/dms')); }
    catch (ex) { return mount(h('p', { class: 'error' }, errText(ex))); }
    const listEl = h('div', { class: 'dm-list' },
      convs.length ? convs.map((c) => h('a', { class: 'dm-conv' + (String(c.user.id) === String(otherId) ? ' active' : ''), href: '#/messages/' + c.user.id },
        avatar(c.user),
        h('div', { class: 'meta' },
          h('div', { class: 'row between', style: 'gap:6px' }, h('strong', {}, c.user.displayName), h('span', { class: 'tiny muted' }, fmtTime(c.last.created_at))),
          h('div', { class: 'snippet' }, (c.last.mine ? t('you') + ': ' : '') + c.last.body)),
        c.unread ? h('span', { class: 'badge' }, c.unread) : null))
        : h('p', { class: 'muted', style: 'padding:16px' }, t('no_conversations'), ' ', h('a', { href: '#/members' }, t('nav_members') + ' →')));
    const thread = h('div', { class: 'dm-thread' });
    const layout = h('section', { class: 'card dm-layout' + (otherId ? ' has-thread' : '') }, listEl, thread);
    mount(pageHead(t('messages_title')), layout);

    if (!otherId) {
      thread.replaceChildren(h('div', { class: 'dm-empty' }, h('p', {}, '✉️', h('br'), t('no_conversations'))));
      return;
    }
    let d;
    try { d = await api('GET', '/api/dms/' + encodeURIComponent(otherId)); }
    catch (ex) { thread.replaceChildren(h('p', { class: 'error', style: 'padding:16px' }, errText(ex))); return; }
    refreshUnread();
    const log = h('div', { class: 'chat-log', 'aria-live': 'polite' });
    const err = h('span', { class: 'error small' });
    const add = (m) => {
      const mine = m.sender_id === state.user.id;
      log.querySelector('.empty')?.remove();
      log.append(h('div', { class: 'msg' + (mine ? ' mine' : ''), 'data-id': m.id },
        h('div', { class: 'bubble' },
          h('div', {}, h('span', { class: 'when', style: 'margin:0' }, fmtTime(m.created_at)),
            mine ? null : h('span', { class: 'tools' }, ' ', h('button', { class: 'iconbtn', onclick: () => report('dm', m.id) }, t('report')))),
          h('div', { class: 'body' }, m.body))));
      log.scrollTop = log.scrollHeight;
    };
    if (!d.messages.length) log.append(h('p', { class: 'muted center empty' }, '👋'));
    d.messages.forEach(add);
    const input = h('textarea', { placeholder: t('dm_placeholder'), maxlength: 2000, rows: 1, 'aria-label': t('dm_placeholder') });
    const form = h('form', { class: 'chat-form' }, input, h('button', { class: 'btn', type: 'submit' }, t('send')));
    const send = async () => {
      const body = input.value.trim(); if (!body) return;
      err.textContent = '';
      try { await api('POST', '/api/dms/' + d.user.id, { body }); input.value = ''; }
      catch (ex) { err.textContent = errText(ex); }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    thread.replaceChildren(
      h('div', { class: 'chat-head' },
        h('a', { href: '#/messages', class: 'btn ghost small', style: 'padding-left:0' }, '←'),
        h('a', { class: 'author', href: '#/u/' + d.user.id }, avatar(d.user, 'sm'), h('strong', {}, d.user.displayName)), err),
      log,
      d.blockedByMe ? h('p', { class: 'notice warm', style: 'margin:12px' }, t('blocked_note')) : form);
    log.scrollTop = log.scrollHeight;
    ensureSocket();
    state.dmListener = (m) => {
      const other = Number(d.user.id);
      if ((m.sender_id === other && m.recipient_id === state.user.id) || (m.sender_id === state.user.id && m.recipient_id === other)) {
        add(m);
        if (m.sender_id === other) api('GET', '/api/dms/' + other).then(refreshUnread).catch(() => {});
        return true;
      }
      return false;
    };
    cleanup = () => { state.dmListener = null; };
  }

  // ---------- events ----------
  async function pageEvents() {
    if (needMember()) return;
    let events;
    try { ({ events } = await api('GET', '/api/events')); }
    catch (ex) { return mount(h('p', { class: 'error' }, errText(ex))); }
    const now = Date.now();
    const upcoming = events.filter((e) => new Date(e.starts_at).getTime() + e.duration_min * 60000 > now);
    const past = events.filter((e) => !upcoming.includes(e)).reverse();
    const langLabel = (l) => (l === 'both' ? 'ES / EN' : l.toUpperCase());
    const evCard = (e, isPast) => {
      const dt = new Date(e.starts_at);
      const rsvp = h('button', { class: 'btn small ' + (e.me_going ? 'secondary' : ''), onclick: async () => {
        await api('POST', `/api/events/${e.id}/rsvp`, { going: !e.me_going }); pageEvents();
      } }, e.me_going ? '✓ ' + t('not_going') : t('going'));
      return h('article', { class: 'card', style: 'display:flex;gap:16px;align-items:flex-start' },
        h('span', { class: 'date-badge', style: 'width:64px' }, h('b', {}, dt.getDate()), h('span', {}, dt.toLocaleDateString(loc(), { month: 'short' }))),
        h('div', { style: 'flex:1;min-width:0' },
          h('h3', { style: 'margin:0' }, e.title),
          h('p', { class: 'muted small', style: 'margin:2px 0 8px' },
            dt.toLocaleString(loc(), { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }) + ` · ${e.duration_min} min · ` + langLabel(e.lang)),
          e.description ? h('p', { class: 'post-body small' }, e.description) : null,
          isPast ? null : h('div', { class: 'row' },
            rsvp,
            e.link ? h('a', { class: 'btn small accent', href: e.link, target: '_blank', rel: 'noopener noreferrer' }, '🎥 ' + t('join_meeting')) : h('span', { class: 'muted small' }, t('link_soon')),
            h('span', { class: 'muted small' }, `${e.going} ${t('going_count')}`),
            state.user.role === 'admin' ? h('button', { class: 'iconbtn', onclick: async () => { if (confirm(t('confirm_delete'))) { await api('DELETE', '/api/events/' + e.id); pageEvents(); } } }, t('delete')) : null)));
    };
    let adminForm = null;
    if (state.user.role === 'admin') {
      const err = h('p', { class: 'error' });
      const f = h('form', { class: 'stack' },
        h('label', {}, t('ev_title'), h('input', { name: 'title', required: true, maxlength: 150 })),
        h('label', {}, t('ev_desc'), h('textarea', { name: 'description', maxlength: 3000, rows: 3 })),
        h('div', { class: 'grid' },
          h('label', {}, t('ev_when'), h('input', { name: 'startsAt', type: 'datetime-local', required: true })),
          h('label', {}, t('ev_duration'), h('input', { name: 'durationMin', type: 'number', min: 15, max: 600, value: 60 })),
          h('label', {}, t('ev_lang'), h('select', { name: 'lang' }, h('option', { value: 'es' }, 'Español'), h('option', { value: 'en' }, 'English'), h('option', { value: 'both' }, t('both_langs'))))),
        h('label', {}, t('ev_link'), h('input', { name: 'link', type: 'url', placeholder: 'https://' })),
        err, h('div', {}, h('button', { class: 'btn', type: 'submit' }, t('create'))));
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fd = Object.fromEntries(new FormData(f));
        fd.startsAt = new Date(fd.startsAt).toISOString();
        try { await api('POST', '/api/events', fd); pageEvents(); } catch (ex) { err.textContent = errText(ex); }
      });
      adminForm = h('details', { class: 'card', style: 'margin-top:24px' }, h('summary', { style: 'cursor:pointer;font-weight:800' }, '➕ ' + t('new_event')), h('div', { style: 'margin-top:14px' }, f));
    }
    mount(
      pageHead(t('events_title'), t('events_lead')),
      upcoming.length ? h('div', { class: 'stack-sm' }, upcoming.map((e) => evCard(e, false))) : h('div', { class: 'card empty-state' }, '📅 ', t('no_events')),
      adminForm,
      past.length ? h('section', { style: 'margin-top:32px' }, h('h2', {}, t('past_events')), h('div', { class: 'stack-sm' }, past.map((e) => evCard(e, true)))) : null);
  }

  // ---------- account ----------
  function resizeImage(file, max = 320) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        // centered square crop, scaled down to at most `max` px
        const side = Math.min(img.width, img.height);
        const c = document.createElement('canvas');
        c.width = c.height = Math.min(max, side);
        const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
        c.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  async function pageAccount() {
    if (needUser()) return;
    const params = new URLSearchParams(location.search);
    const hashQ = new URLSearchParams((location.hash.split('?')[1]) || '');
    let banner = null;
    if (params.get('checkout') === 'success') {
      banner = h('div', { class: 'notice' }, t('checkout_success'));
      try { const { user } = await api('POST', '/api/billing/sync'); state.user = user; } catch {}
      history.replaceState(null, '', location.pathname + location.hash);
    } else if (hashQ.get('welcome')) {
      banner = h('div', { class: 'notice warm' }, '💙 ' + t('complete_profile'));
    }
    const u = state.user;
    const msg = h('span', { class: 'muted small' });
    let avatarData;
    const avWrap = h('div', {}, avatar(u, 'lg'));
    const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: 'display:none' });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0]; if (!f) return;
      try { avatarData = await resizeImage(f); avWrap.replaceChildren(h('img', { class: 'avatar lg', src: avatarData, alt: '' })); }
      catch { msg.textContent = t('err_avatar'); }
    });
    const field = (label, el) => h('label', {}, label, el);
    const nameIn = h('input', { name: 'displayName', value: u.displayName, maxlength: 40, required: true });
    const locIn = h('input', { name: 'location', value: u.location, maxlength: 80, placeholder: t('location_ph') });
    const teenIn = h('input', { name: 'teenInfo', value: u.teenInfo, maxlength: 160, placeholder: t('teen_ph') });
    const intIn = h('input', { name: 'interests', value: u.interests, maxlength: 200, placeholder: t('interests_ph') });
    const bioIn = h('textarea', { name: 'bio', maxlength: 600, rows: 4, placeholder: t('bio_ph') }, u.bio);
    const dmIn = h('input', { type: 'checkbox', checked: u.allowDms || undefined });
    const profile = h('form', { class: 'stack' },
      h('div', { class: 'row' }, avWrap,
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn secondary small', onclick: () => fileIn.click() }, '📷 ' + t('change_photo')),
          u.avatar ? h('button', { type: 'button', class: 'btn ghost small', onclick: () => { avatarData = null; avWrap.replaceChildren(avatar({ ...u, avatar: null }, 'lg')); } }, t('remove_photo')) : null),
        fileIn),
      h('div', { class: 'grid' }, field(t('display_name'), nameIn), field(t('location'), locIn)),
      field(t('teen'), teenIn),
      field(t('about_me'), bioIn),
      field(t('interests'), intIn),
      h('label', { class: 'check' }, dmIn, t('allow_dms')),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, t('save')), msg));
    profile.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { displayName: nameIn.value, location: locIn.value, teenInfo: teenIn.value, interests: intIn.value, bio: bioIn.value, allowDms: dmIn.checked };
      if (avatarData !== undefined) body.avatar = avatarData;
      try { const r = await api('PATCH', '/api/me', body); state.user = r.user; msg.textContent = t('saved'); renderChrome(); }
      catch (ex) { msg.textContent = errText(ex); }
    });

    const billing = h('section', { class: 'card', style: 'margin-top:16px' }, h('h2', {}, t('membership')));
    if (state.config.paymentsEnabled) {
      billing.append(
        h('p', {}, h('strong', {}, t('status') + ': '), (t('st')[u.subscriptionStatus] || u.subscriptionStatus)),
        u.currentPeriodEnd ? h('p', {}, h('strong', {}, t('renews') + ': '), fmtDate(u.currentPeriodEnd)) : '');
      const bErr = h('p', { class: 'error' });
      if (u.subscriptionStatus !== 'none') {
        billing.append(h('button', { class: 'btn secondary', onclick: async () => {
          try { const { url } = await api('POST', '/api/billing/portal'); location.href = url; } catch (ex) { bErr.textContent = errText(ex); }
        } }, t('manage_billing')));
      }
      if (!u.isMember) billing.append(' ', h('a', { class: 'btn', href: '#/join' }, t('subscribe_now')));
      billing.append(bErr);
    } else {
      billing.append(h('p', { class: 'muted', style: 'margin:0' }, '✓ ' + t('price_free')));
    }

    const logout = h('button', { class: 'btn danger', style: 'margin-top:16px', onclick: async () => {
      await api('POST', '/api/logout'); state.user = null; state.unread = 0;
      if (state.socket) { state.socket.disconnect(); state.socket = null; }
      go('#/');
    } }, t('nav_logout'));

    const nodes = [banner, pageHead(t('account_title')),
      h('section', { class: 'card' }, h('h2', {}, t('profile')), profile,
        h('p', { class: 'muted small', style: 'margin:14px 0 0' }, t('email') + ': ' + u.email)),
      billing];
    if (u.role === 'admin') nodes.push(await adminReports());
    nodes.push(logout);
    mount(...nodes);
  }

  async function adminReports() {
    const box = h('section', { class: 'card', style: 'margin-top:16px' }, h('h2', {}, t('admin_reports')));
    try {
      const { reports } = await api('GET', '/api/admin/reports');
      if (!reports.length) box.append(h('p', { class: 'muted', style: 'margin:0' }, t('no_reports')));
      for (const r of reports) {
        const row = h('div', { class: 'reply' },
          h('div', { class: 'small muted' }, `${r.kind} #${r.target_id} · ${t('reported_by')} ${r.reporter} · ${fmtTime(r.created_at)}`),
          r.reason ? h('div', { class: 'small' }, '“' + r.reason + '”') : null,
          h('div', { class: 'post-body' }, r.content || '—'),
          h('div', { class: 'row', style: 'margin-top:6px' },
            h('button', { class: 'btn small danger', onclick: async () => { await api('POST', `/api/admin/reports/${r.id}/resolve`, { removeContent: true }); row.remove(); } }, t('remove_content')),
            h('button', { class: 'btn small secondary', onclick: async () => { await api('POST', `/api/admin/reports/${r.id}/resolve`, {}); row.remove(); } }, t('dismiss'))));
        box.append(row);
      }
    } catch {}
    return box;
  }

  // ---------- router ----------
  function route() {
    if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
    renderChrome();
    const hash = location.hash.replace(/^#/, '') || '/';
    const [p, qs] = hash.split('?');
    const parts = p.split('/').filter(Boolean);
    const q = new URLSearchParams(qs || '');
    switch (parts[0]) {
      case undefined: return state.user ? pageHome() : pageLanding();
      case 'home': return pageHome();
      case 'login': return pageAuth('login');
      case 'register': return pageAuth('register');
      case 'join': return pageJoin();
      case 'learn': return pageLearn(parts[1]);
      case 'resources': return pageResources();
      case 'rooms': return parts[1] ? pageChat(parts[1]) : pageRooms();
      case 'forum':
        if (parts[1] === 'new') return pageNewPost();
        if (parts[1]) return pagePost(parts[1]);
        return pageForum(q.get('c'));
      case 'members': return pageMembers();
      case 'u': return pageProfile(parts[1]);
      case 'messages': return pageMessages(parts[1]);
      case 'events': return SHOW_EVENTS ? pageEvents() : (state.user ? pageHome() : pageLanding());
      case 'account': return pageAccount();
      default: return state.user ? pageHome() : pageLanding();
    }
  }
  window.addEventListener('hashchange', route);

  (async function boot() {
    document.documentElement.lang = state.lang;
    try { state.config = await api('GET', '/api/config'); } catch {}
    try { const { user } = await api('GET', '/api/me'); state.user = user; } catch {}
    ensureSocket();
    refreshUnread();
    route();
  })();
})();
