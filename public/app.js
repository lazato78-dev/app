// Círculo Azul — single-page frontend (vanilla JS, hash routing).
(() => {
  const state = { user: null, config: { paymentsEnabled: false, priceLabel: '', categories: [] }, lang: null, socket: null };
  const $main = document.getElementById('main');

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
  function setLang(l) {
    state.lang = l;
    try { localStorage.setItem('lang', l); } catch {}
    document.documentElement.lang = l;
    if (state.user && state.user.lang !== l) api('PATCH', '/api/me', { lang: l }).catch(() => {});
    renderChrome();
    route();
  }

  // ---------- utils ----------
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v; // only used with authored content
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
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
    return t('err_' + e.code) !== 'err_' + e.code ? t('err_' + e.code) : t('err_generic');
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    const diff = (Date.now() - d) / 1000;
    if (diff < 45) return t('just_now');
    const loc = state.lang === 'en' ? 'en-US' : 'es-MX';
    const sameDay = new Date().toDateString() === d.toDateString();
    return sameDay
      ? d.toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString(loc, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit' });
  }
  function mount(...nodes) {
    $main.replaceChildren(...nodes);
    $main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  const go = (hash) => { location.hash = hash; };

  // ---------- chrome ----------
  function renderChrome() {
    const nav = document.getElementById('nav');
    const cur = location.hash || '#/';
    const link = (href, label) => h('a', { href, class: cur.startsWith(href) && (href !== '#/' || cur === '#/') ? 'active' : '' }, label);
    const items = [link('#/learn', t('nav_learn'))];
    if (state.user) {
      items.push(link('#/rooms', t('nav_rooms')), link('#/forum', t('nav_forum')), link('#/account', t('nav_account')));
    } else {
      items.push(link('#/login', t('nav_login')), h('a', { href: '#/register', class: 'btn small' }, t('nav_join')));
    }
    items.push(h('div', { class: 'lang-toggle', role: 'group', 'aria-label': 'Language' },
      h('button', { class: state.lang === 'es' ? 'on' : '', onclick: () => setLang('es'), 'aria-pressed': state.lang === 'es' }, 'ES'),
      h('button', { class: state.lang === 'en' ? 'on' : '', onclick: () => setLang('en'), 'aria-pressed': state.lang === 'en' }, 'EN')));
    nav.replaceChildren(...items);
    nav.classList.remove('open');
    document.getElementById('menuBtn').setAttribute('aria-expanded', 'false');
    document.getElementById('footer').replaceChildren(
      h('p', {}, t('footer_disclaimer')),
      h('p', {}, t('footer_crisis')),
      h('p', {}, h('a', { href: '#/learn/guidelines' }, t('guidelines')), ' · © ' + new Date().getFullYear() + ' Círculo Azul'));
  }
  document.getElementById('menuBtn').addEventListener('click', (e) => {
    const nav = document.getElementById('nav');
    const open = nav.classList.toggle('open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });

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

  // ---------- pages ----------
  function heroArt() {
    const svg = `<svg class="hero-art" viewBox="0 0 200 200" role="img" aria-label="">
      <circle cx="100" cy="100" r="82" fill="none" stroke="var(--primary)" stroke-width="18" opacity=".9"/>
      <circle cx="100" cy="100" r="52" fill="var(--primary-soft)"/>
      <circle cx="82" cy="84" r="12" fill="var(--accent)"/>
      <path d="M62 128a20 22 0 0 1 40 0z" fill="var(--accent)"/>
      <circle cx="120" cy="90" r="10" fill="var(--primary)"/>
      <path d="M103 128a17 19 0 0 1 34 0z" fill="var(--primary)"/>
    </svg>`;
    const d = document.createElement('div'); d.innerHTML = svg; return d.firstElementChild;
  }

  function pageHome() {
    const price = state.config.paymentsEnabled ? (state.config.priceLabel || '') : t('price_free');
    mount(
      h('section', { class: 'hero' },
        h('div', {},
          h('h1', {}, t('hero_title')),
          h('p', { class: 'lead' }, t('hero_lead')),
          h('div', { class: 'row' },
            state.user
              ? h('a', { class: 'btn', href: '#/rooms' }, t('nav_rooms'))
              : h('a', { class: 'btn', href: '#/register' }, t('hero_cta')),
            h('a', { class: 'btn secondary', href: '#/learn' }, t('hero_cta2')))),
        heroArt()),
      h('section', { class: 'grid features' },
        ...[['💬', 'f_chat'], ['📝', 'f_forum'], ['📘', 'f_learn'], ['🛡️', 'f_safe']].map(([ic, k]) =>
          h('div', { class: 'card' }, h('h3', {}, h('span', { 'aria-hidden': 'true' }, ic), t(k + '_t')), h('p', { class: 'muted' }, t(k + '_d'))))),
      h('section', { class: 'card center', style: 'margin-top:32px' },
        h('h2', {}, t('price_title')),
        price ? h('p', { class: 'price' }, price) : null,
        h('ul', { style: 'list-style:none;padding:0' }, ...t('join_includes').map((x) => h('li', {}, '✓ ' + x))),
        h('p', { class: 'muted small' }, t('price_note')),
        h('a', { class: 'btn', href: state.user ? '#/join' : '#/register' }, t('hero_cta'))),
    );
  }

  function pageAuth(mode) {
    if (state.user) return go('#/rooms');
    const isReg = mode === 'register';
    const err = h('p', { class: 'error', role: 'alert' });
    const form = h('form', { class: 'stack' },
      isReg ? h('label', {}, t('display_name'), h('input', { name: 'displayName', required: true, maxlength: 40, autocomplete: 'nickname' }), h('span', { class: 'muted small' }, t('display_name_hint'))) : null,
      h('label', {}, t('email'), h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
      h('label', {}, t('password'), h('input', { name: 'password', type: 'password', required: true, minlength: isReg ? 8 : null, autocomplete: isReg ? 'new-password' : 'current-password' }),
        isReg ? h('span', { class: 'muted small' }, t('password_hint')) : null),
      err,
      h('button', { class: 'btn', type: 'submit' }, isReg ? t('btn_register') : t('btn_login')),
      isReg ? h('p', { class: 'muted small' }, t('agree'), ' ', h('a', { href: '#/learn/guidelines' }, t('guidelines'))) : null,
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
        renderChrome();
        go(user.isMember ? '#/rooms' : '#/join');
      } catch (ex) { err.textContent = errText(ex); btn.disabled = false; }
    });
    mount(h('div', { class: 'card narrow' },
      h('h1', {}, isReg ? t('register_title') : t('login_title')),
      form,
      h('p', { class: 'center small', style: 'margin-top:16px' },
        isReg ? t('have_account') : t('no_account'), ' ',
        h('a', { href: isReg ? '#/login' : '#/register' }, isReg ? t('nav_login') : t('nav_join')))));
  }

  function pageJoin() {
    if (needUser()) return;
    if (state.user.isMember) return go('#/account');
    const err = h('p', { class: 'error', role: 'alert' });
    const btn = h('button', { class: 'btn' }, t('join_btn'));
    btn.addEventListener('click', async () => {
      btn.disabled = true; err.textContent = t('join_redirect');
      try { const { url } = await api('POST', '/api/billing/checkout'); location.href = url; }
      catch (ex) { err.textContent = errText(ex); btn.disabled = false; }
    });
    mount(h('div', { class: 'card narrow center' },
      h('h1', {}, t('join_title')),
      h('p', { class: 'muted' }, t('join_lead')),
      state.config.priceLabel ? h('p', { class: 'price' }, state.config.priceLabel) : null,
      h('ul', { style: 'list-style:none;padding:0;text-align:left;display:inline-block' }, ...t('join_includes').map((x) => h('li', {}, '✓ ' + x))),
      h('div', {}, btn), err,
      h('p', { class: 'muted small' }, t('price_note'))));
  }

  function pageLearn(slug) {
    const items = CONTENT;
    const toc = h('nav', { class: 'toc', 'aria-label': t('learn_title') },
      ...items.map((it) => h('a', { href: '#/learn/' + it.slug, class: it.slug === slug ? 'active' : '' }, it.icon + ' ' + it[state.lang].title)));
    if (!slug) {
      mount(
        h('h1', {}, t('learn_title')),
        h('p', { class: 'muted' }, t('learn_lead')),
        h('div', { class: 'grid' }, ...items.map((it) =>
          h('a', { class: 'card room-card', href: '#/learn/' + it.slug },
            h('span', { class: 'room-icon', 'aria-hidden': 'true' }, it.icon),
            h('div', {}, h('h3', {}, it[state.lang].title), h('p', { class: 'muted small' }, it[state.lang].summary))))));
      return;
    }
    const it = items.find((x) => x.slug === slug);
    if (!it) return go('#/learn');
    mount(h('div', { class: 'learn-layout' }, toc,
      h('article', { class: 'article' }, h('h1', {}, it.icon + ' ' + it[state.lang].title), h('div', { html: it[state.lang].html }))));
  }

  async function pageRooms() {
    if (needMember()) return;
    mount(h('p', { class: 'muted' }, '…'));
    try {
      const { rooms } = await api('GET', '/api/rooms');
      mount(
        h('h1', {}, t('rooms_title')),
        h('p', { class: 'muted' }, t('rooms_lead')),
        h('div', { class: 'grid' }, ...rooms.map((r) =>
          h('a', { class: 'card room-card', href: '#/rooms/' + r.slug },
            h('span', { class: 'room-icon', 'aria-hidden': 'true' }, r.icon),
            h('div', {},
              h('h3', {}, state.lang === 'en' ? r.name_en : r.name_es),
              h('p', { class: 'muted small', style: 'margin:0' }, state.lang === 'en' ? r.desc_en : r.desc_es),
              r.last_message_at ? h('span', { class: 'pill', style: 'margin-top:6px' }, fmtTime(r.last_message_at)) : null)))));
    } catch (ex) { mount(h('p', { class: 'error' }, errText(ex))); }
  }

  function getSocket() {
    if (!state.socket) {
      state.socket = io({ withCredentials: true });
    }
    return state.socket;
  }

  async function pageChat(slug) {
    if (needMember()) return;
    let data;
    try { data = await api('GET', `/api/rooms/${encodeURIComponent(slug)}/messages`); }
    catch (ex) { return mount(h('p', { class: 'error' }, errText(ex))); }
    const { room } = data;
    const log = h('div', { class: 'chat-log', 'aria-live': 'polite' });
    const presence = h('span', { class: 'pill accent' }, '');
    const status = h('span', { class: 'muted small' });
    const input = h('textarea', { placeholder: t('type_message'), maxlength: 2000, 'aria-label': t('type_message'), rows: 1 });
    const err = h('span', { class: 'error small' });
    let oldestId = null;

    function msgEl(m) {
      const mine = m.user_id === state.user.id;
      const tools = h('span', { class: 'tools' });
      if (mine || state.user.role === 'admin') {
        tools.append(h('button', { class: 'iconbtn', onclick: () => {
          if (confirm(t('confirm_delete'))) getSocket().emit('delete', m.id);
        } }, t('delete')));
      }
      if (!mine) tools.append(h('button', { class: 'iconbtn', onclick: () => report('message', m.id) }, t('report')));
      return h('div', { class: 'msg' + (mine ? ' mine' : ''), 'data-id': m.id, tabindex: 0 },
        h('div', {}, h('span', { class: 'who' }, m.display_name), h('span', { class: 'when' }, fmtTime(m.created_at)), ' ', tools),
        h('div', { class: 'body' }, m.body));
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
      getSocket().emit('message', { body }, (res) => {
        if (res?.error) err.textContent = errText({ code: res.error });
      });
      input.value = '';
      input.style.height = '';
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; });

    mount(
      h('p', { style: 'margin:0 0 10px' }, h('a', { href: '#/rooms' }, t('back_rooms'))),
      h('section', { class: 'card chat' },
        h('div', { class: 'chat-head' },
          h('span', { class: 'room-icon', 'aria-hidden': 'true' }, room.icon),
          h('h2', { style: 'margin:0;font-size:1.15rem' }, state.lang === 'en' ? room.name_en : room.name_es),
          presence, status, err),
        log, form));
    addMessages(data.messages, false);
    log.scrollTop = log.scrollHeight;

    const sock = getSocket();
    const join = () => sock.emit('join', slug);
    const onMsg = (m) => addMessages([m], false);
    const onDel = ({ id }) => log.querySelector(`.msg[data-id="${id}"]`)?.remove();
    const onPres = (p) => { if (p.slug === slug) presence.textContent = `${p.count} ${t('online')}`; };
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
    input.focus();
  }

  async function report(kind, id) {
    const reason = prompt(t('report_reason'));
    if (reason === null) return;
    try { await api('POST', '/api/reports', { kind, targetId: id, reason }); alert(t('reported')); }
    catch (ex) { alert(errText(ex)); }
  }

  async function pageForum(cat) {
    if (needMember()) return;
    const cats = state.config.categories;
    let posts;
    try { ({ posts } = await api('GET', '/api/posts' + (cat ? `?category=${encodeURIComponent(cat)}` : ''))); }
    catch (ex) { return mount(h('p', { class: 'error' }, errText(ex))); }
    const catName = (c) => t('cat')[c] || c;
    mount(
      h('div', { class: 'row', style: 'justify-content:space-between' },
        h('h1', { style: 'margin:0' }, t('forum_title')),
        h('a', { class: 'btn', href: '#/forum/new' }, '+ ' + t('new_post'))),
      h('p', { class: 'muted' }, t('forum_lead')),
      h('div', { class: 'filters' },
        h('button', { class: !cat ? 'on' : '', onclick: () => go('#/forum') }, t('all')),
        ...cats.map((c) => h('button', { class: cat === c ? 'on' : '', onclick: () => go('#/forum?c=' + c) }, catName(c)))),
      posts.length
        ? h('div', { class: 'post-list' }, ...posts.map((p) =>
            h('a', { class: 'card post-item', href: '#/forum/' + p.id },
              h('div', {},
                h('h3', { style: 'margin:0 0 4px' }, p.title),
                h('span', { class: 'muted small' }, p.display_name + ' · ' + fmtTime(p.created_at) + ' '), h('span', { class: 'pill' }, catName(p.category))),
              h('div', { class: 'muted small', style: 'white-space:nowrap' }, `${p.reply_count} ${p.reply_count === 1 ? t('reply_one') : t('replies')}`))))
        : h('p', { class: 'muted' }, t('no_posts')));
  }

  function pageNewPost() {
    if (needMember()) return;
    const err = h('p', { class: 'error', role: 'alert' });
    const form = h('form', { class: 'stack' },
      h('label', {}, t('title'), h('input', { name: 'title', required: true, maxlength: 150 })),
      h('label', {}, t('category'), h('select', { name: 'category' }, ...state.config.categories.map((c) => h('option', { value: c }, t('cat')[c] || c)))),
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
    const actions = (kind, item) => h('span', { class: 'row', style: 'gap:4px' },
      canDel(item.user_id) ? h('button', { class: 'iconbtn', onclick: async () => {
        if (!confirm(t('confirm_delete'))) return;
        await api('DELETE', (kind === 'post' ? '/api/posts/' : '/api/replies/') + item.id);
        kind === 'post' ? go('#/forum') : pagePost(id);
      } }, t('delete')) : null,
      item.user_id !== state.user.id ? h('button', { class: 'iconbtn', onclick: () => report(kind, item.id) }, t('report')) : null);
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
        h('h1', { style: 'margin-top:8px' }, post.title),
        h('p', { class: 'muted small' }, post.display_name + ' · ' + fmtTime(post.created_at) + ' '), actions('post', post),
        h('div', { class: 'post-body', style: 'margin-top:12px' }, post.body)),
      h('section', { class: 'card', style: 'margin-top:16px' },
        h('h2', {}, `${replies.length} ${replies.length === 1 ? t('reply_one') : t('replies')}`),
        ...replies.map((r) => h('div', { class: 'reply' },
          h('div', { class: 'small' }, h('strong', {}, r.display_name), h('span', { class: 'muted' }, ' · ' + fmtTime(r.created_at) + ' '), actions('reply', r)),
          h('div', { class: 'post-body' }, r.body))),
        form));
  }

  async function pageAccount() {
    if (needUser()) return;
    const params = new URLSearchParams(location.search);
    let banner = null;
    if (params.get('checkout') === 'success') {
      banner = h('div', { class: 'notice' }, t('checkout_success'));
      try { const { user } = await api('POST', '/api/billing/sync'); state.user = user; } catch {}
      history.replaceState(null, '', location.pathname + location.hash);
    }
    const u = state.user;
    const msg = h('span', { class: 'muted small' });
    const nameIn = h('input', { name: 'displayName', value: u.displayName, maxlength: 40, required: true });
    const profile = h('form', { class: 'stack' },
      h('label', {}, t('display_name'), nameIn),
      h('label', {}, t('email'), h('input', { value: u.email, disabled: true })),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, t('save')), msg));
    profile.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { const r = await api('PATCH', '/api/me', { displayName: nameIn.value }); state.user = r.user; msg.textContent = t('saved'); }
      catch (ex) { msg.textContent = errText(ex); }
    });

    const billing = h('section', { class: 'card', style: 'margin-top:16px' }, h('h2', {}, t('membership')));
    if (state.config.paymentsEnabled) {
      billing.append(
        h('p', {}, h('strong', {}, t('status') + ': '), (t('st')[u.subscriptionStatus] || u.subscriptionStatus)),
        u.currentPeriodEnd ? h('p', {}, h('strong', {}, t('renews') + ': '), new Date(u.currentPeriodEnd).toLocaleDateString(state.lang === 'en' ? 'en-US' : 'es-MX')) : null);
      const bErr = h('p', { class: 'error' });
      if (u.subscriptionStatus !== 'none') {
        billing.append(h('button', { class: 'btn secondary', onclick: async () => {
          try { const { url } = await api('POST', '/api/billing/portal'); location.href = url; } catch (ex) { bErr.textContent = errText(ex); }
        } }, t('manage_billing')));
      }
      if (!u.isMember) billing.append(' ', h('a', { class: 'btn', href: '#/join' }, t('subscribe_now')));
      billing.append(bErr);
    } else {
      billing.append(h('p', { class: 'muted' }, t('price_free')));
    }

    const logout = h('button', { class: 'btn danger', style: 'margin-top:16px', onclick: async () => {
      await api('POST', '/api/logout'); state.user = null;
      if (state.socket) { state.socket.disconnect(); state.socket = null; }
      renderChrome(); go('#/');
    } }, t('nav_logout'));

    const nodes = [banner, h('h1', {}, t('account_title')), h('section', { class: 'card' }, profile), billing];
    if (u.role === 'admin') nodes.push(await adminReports());
    nodes.push(logout);
    mount(...nodes.filter(Boolean));
  }

  async function adminReports() {
    const box = h('section', { class: 'card', style: 'margin-top:16px' }, h('h2', {}, t('admin_reports')));
    try {
      const { reports } = await api('GET', '/api/admin/reports');
      if (!reports.length) box.append(h('p', { class: 'muted' }, t('no_reports')));
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
  let cleanup = null;
  function route() {
    if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
    renderChrome();
    const hash = location.hash.replace(/^#/, '') || '/';
    const [p, qs] = hash.split('?');
    const parts = p.split('/').filter(Boolean);
    const q = new URLSearchParams(qs || '');
    switch (parts[0]) {
      case undefined: return pageHome();
      case 'login': return pageAuth('login');
      case 'register': return pageAuth('register');
      case 'join': return pageJoin();
      case 'learn': return pageLearn(parts[1]);
      case 'rooms': return parts[1] ? pageChat(parts[1]) : pageRooms();
      case 'forum':
        if (parts[1] === 'new') return pageNewPost();
        if (parts[1]) return pagePost(parts[1]);
        return pageForum(q.get('c'));
      case 'account': return pageAccount();
      default: return pageHome();
    }
  }
  window.addEventListener('hashchange', route);

  (async function boot() {
    document.documentElement.lang = state.lang;
    try { state.config = await api('GET', '/api/config'); } catch {}
    try { const { user } = await api('GET', '/api/me'); state.user = user; } catch {}
    route();
  })();
})();
