(() => {
  if (window.top !== window) return;
  if (window.__kickFollowingChatters) return;
  window.__kickFollowingChatters = true;

  const PUSHER_URL =
    'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';
  const MAX_ROOMS = 60;
  const DEFAULT_INITIAL_COUNT = 5;

  const DEFAULTS = {
    mode: 'chatters',
    windowMin: 5,
    pollSec: 30,
    useApi: true,
    ignoreBots: true,
    bots: 'botrix,kickbot,nightbot,streamelements,fossabot,moobot,wizebot',
    initialCount: DEFAULT_INITIAL_COUNT,
    expanded: false
  };

  let S = { ...DEFAULTS };
  let idCache = {};
  const channels = new Map();
  const roomToSlug = new Map();
  const chatLog = new Map();
  let loginNeeded = false;
  let lastFollowOk = 0;
  let timers = [];
  let isExpanded = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- Kick HTTP ---------- */

  function sessionToken() {
    const m = document.cookie.match(/(?:^|;\s*)session_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function kickGet(path) {
    const headers = { Accept: 'application/json' };
    const token = sessionToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    const url = path.startsWith('http') ? path : (path.startsWith('/') ? path : '/' + path);
    const res = await fetch(url, { headers, credentials: 'include' });
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function fetchFollowed() {
    let out = [];
    let cursor = null;
    for (let i = 0; i < 10; i++) {
      const url = '/api/v2/channels/followed' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '');
      const json = await kickGet(url);
      const list = Array.isArray(json) ? json : json.channels || json.data || [];
      out = out.concat(list);
      const next = json.nextCursor || json.next_cursor || json.cursor || null;
      if (!next || next === cursor || !list.length) break;
      cursor = next;
    }
    return out;
  }

  function normalize(raw) {
    if (!raw) return null;
    const ls = raw.livestream || null;
    const slug = String(raw.channel_slug || raw.slug || (raw.user && raw.user.username) || '').toLowerCase();
    if (!slug) return null;
    const user = raw.user || {};
    const cat = ls && ls.categories && ls.categories[0] ? ls.categories[0].name : '';
    const isLive = raw.is_live != null ? !!raw.is_live : !!(ls && ls.is_live !== false);
    return {
      slug,
      name: raw.user_username || user.username || raw.channel_slug || raw.slug || slug,
      avatar: raw.profile_picture || user.profile_pic || user.avatar || '',
      category: raw.category_name || cat || (ls && ls.category && ls.category.name) || '',
      live: isLive,
      viewers: Number(raw.viewer_count != null ? raw.viewer_count : ls ? ls.viewer_count : 0) || 0,
      channelId: raw.id || (user && user.id) || null,
      streamTitle: (ls && (ls.session_title || ls.title)) || ''
    };
  }

  async function refreshFollowed() {
    try {
      const raw = await fetchFollowed();
      loginNeeded = false;
      lastFollowOk = Date.now();
      const seen = new Set();
      for (const r of raw) {
        const n = normalize(r);
        if (!n) continue; // Keep ALL channels (live & offline)
        seen.add(n.slug);
        const old = channels.get(n.slug) || { slug: n.slug, subAt: 0, coveredFrom: Date.now() };
        Object.assign(old, n, { channelId: n.channelId || old.channelId });
        channels.set(n.slug, old);
      }
      for (const slug of [...channels.keys()]) {
        if (!seen.has(slug)) {
          channels.delete(slug);
          chatLog.delete(slug);
        }
      }
      await resolveIds();
      syncSubs();
    } catch (e) {
      if (e.status === 401 || e.status === 403) loginNeeded = true;
    }
    render();
  }

  async function resolveIds() {
    for (const ch of channels.values()) {
      if (!ch.live) continue; // Only resolve live channels
      const cached = idCache[ch.slug];
      if (cached) {
        ch.channelId = cached.channelId || ch.channelId;
        ch.chatroomId = cached.chatroomId;
      }
      if (ch.chatroomId && ch.channelId) {
        roomToSlug.set(Number(ch.chatroomId), ch.slug);
        continue;
      }
      try {
        const j = await kickGet('/api/v2/channels/' + encodeURIComponent(ch.slug));
        ch.channelId = j.id || ch.channelId;
        ch.chatroomId = j.chatroom && j.chatroom.id;
        if (ch.chatroomId) {
          idCache[ch.slug] = { channelId: ch.channelId, chatroomId: ch.chatroomId };
          roomToSlug.set(Number(ch.chatroomId), ch.slug);
          chrome.storage.local.set({ idCache });
        }
      } catch (e) {
        /* retry on next refresh */
      }
      await sleep(250);
    }
  }

  /* ---------- Chatter tracking (floor) ---------- */

  function botSet() {
    return new Set(
      String(S.bots || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
  }

  function record(slug, key, name, ts) {
    if (S.ignoreBots && botSet().has(String(name || '').toLowerCase())) return;
    let m = chatLog.get(slug);
    if (!m) {
      m = new Map();
      chatLog.set(slug, m);
    }
    if ((m.get(key) || 0) < ts) m.set(key, ts);
  }

  function countRecent(slug, now) {
    const m = chatLog.get(slug);
    if (!m) return 0;
    const cutoff = now - S.windowMin * 60000;
    let n = 0;
    for (const ts of m.values()) if (ts >= cutoff) n++;
    return n;
  }

  function prune() {
    const cutoff = Date.now() - S.windowMin * 60000;
    for (const m of chatLog.values()) {
      for (const [k, ts] of m) if (ts < cutoff) m.delete(k);
    }
  }

  async function seedHistory(ch) {
    if (!ch.channelId || !ch.live) return;
    try {
      const j = await kickGet('/api/v2/channels/' + ch.channelId + '/messages');
      const msgs = (j.data && j.data.messages) || j.messages || [];
      const cutoff = Date.now() - S.windowMin * 60000;
      let oldest = Date.now();
      for (const m of msgs) {
        const ts = Date.parse(m.created_at);
        if (!ts || !m.sender) continue;
        oldest = Math.min(oldest, ts);
        if (ts < cutoff) continue;
        const u = m.sender;
        record(ch.slug, u.id != null ? String(u.id) : String(u.username).toLowerCase(), u.username, ts);
      }
      ch.coveredFrom = Math.min(ch.coveredFrom || Date.now(), oldest);
    } catch (e) {
      /* history is optional */
    }
  }

  /* ---------- Pusher socket ---------- */

  const ws = { sock: null, ready: false, subs: new Set(), backoff: 2000, lastRx: 0 };

  function wsSend(obj) {
    if (ws.sock && ws.sock.readyState === 1) ws.sock.send(JSON.stringify(obj));
  }

  function wsConnect() {
    if (ws.sock) return;
    let s;
    try {
      s = new WebSocket(PUSHER_URL);
    } catch (e) {
      setTimeout(wsConnect, ws.backoff);
      return;
    }
    ws.sock = s;
    ws.lastRx = Date.now();
    s.onmessage = (e) => {
      ws.lastRx = Date.now();
      onFrame(e.data);
    };
    s.onerror = () => {
      try {
        s.close();
      } catch (e) {
        /* ignore */
      }
    };
    s.onclose = () => {
      ws.sock = null;
      ws.ready = false;
      ws.subs.clear();
      setTimeout(wsConnect, ws.backoff);
      ws.backoff = Math.min(ws.backoff * 2, 60000);
    };
  }

  function onFrame(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (m.event === 'pusher:connection_established') {
      ws.ready = true;
      ws.backoff = 2000;
      syncSubs();
    } else if (m.event === 'pusher:ping') {
      wsSend({ event: 'pusher:pong', data: {} });
    } else if (m.event === 'App\\Events\\ChatMessageEvent') {
      onChat(m);
    }
  }

  function onChat(m) {
    const room = /^chatrooms\.(\d+)\.v2$/.exec(m.channel || '');
    if (!room) return;
    const slug = roomToSlug.get(Number(room[1]));
    if (!slug) return;
    let d;
    try {
      d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data;
    } catch (e) {
      return;
    }
    const u = d && d.sender;
    if (!u) return;
    record(slug, u.id != null ? String(u.id) : String(u.username).toLowerCase(), u.username, Date.now());
    requestRender();
  }

  function syncSubs() {
    if (!ws.ready) return;
    const want = new Map();
    for (const ch of channels.values()) {
      if (ch.live && ch.chatroomId && want.size < MAX_ROOMS) {
        want.set('chatrooms.' + ch.chatroomId + '.v2', ch);
      }
    }
    for (const [name, ch] of want) {
      if (ws.subs.has(name)) continue;
      ws.subs.add(name);
      ch.subAt = Date.now();
      ch.coveredFrom = Date.now();
      wsSend({ event: 'pusher:subscribe', data: { auth: '', channel: name } });
      seedHistory(ch);
    }
    for (const name of [...ws.subs]) {
      if (!want.has(name)) {
        ws.subs.delete(name);
        wsSend({ event: 'pusher:unsubscribe', data: { channel: name } });
      }
    }
  }

  function heartbeat() {
    if (!ws.sock) return;
    if (Date.now() - ws.lastRx > 90000) {
      try {
        ws.sock.close();
      } catch (e) {
        /* ignore */
      }
      return;
    }
    wsSend({ event: 'pusher:ping', data: {} });
  }

  /* ---------- Kick active chatters (ceiling) ---------- */

  function countFrom(j) {
    if (!j || typeof j !== 'object') return null;
    const d = j.data || j;
    if (typeof d.total_count === 'number') {
      const bots = S.ignoreBots && Array.isArray(d.bots) ? d.bots.length : 0;
      return Math.max(0, d.total_count - bots);
    }
    if (Array.isArray(d.chatters)) {
      const bots = S.ignoreBots && Array.isArray(d.bots) ? d.bots.length : 0;
      const mods = Array.isArray(d.moderators) ? d.moderators.length : 0;
      const ogs = Array.isArray(d.ogs) ? d.ogs.length : 0;
      const vips = Array.isArray(d.vips) ? d.vips.length : 0;
      return Math.max(0, d.chatters.length + mods + ogs + vips - bots);
    }
    for (const k of ['count', 'total', 'total_count', 'active_chatters', 'chatters_count']) {
      if (typeof d[k] === 'number') return d[k];
    }
    for (const k of ['chatters', 'users', 'active_chatters']) {
      const v = d[k];
      if (Array.isArray(v)) return v.length;
    }
    return null;
  }

  async function pollApi() {
    if (!S.useApi) return;
    for (const ch of [...channels.values()]) {
      if (!ch.live) continue;
      if (ch.apiOff) continue;

      let ok = false;
      const candidates = [];
      // 1. web.kick.com active-chatters with channelId (Kick's new working endpoint)
      if (ch.channelId) {
        candidates.push('https://web.kick.com/api/v1/channels/' + encodeURIComponent(ch.channelId) + '/chat/active-chatters');
      }
      // 2. Fallbacks
      if (ch.channelId) {
        candidates.push('/api/v1/channels/' + encodeURIComponent(ch.channelId) + '/chat/active-chatters');
      }
      if (ch.slug) {
        candidates.push('https://web.kick.com/api/v1/channels/' + encodeURIComponent(ch.slug) + '/chat/active-chatters');
        candidates.push('/api/v1/channels/' + encodeURIComponent(ch.slug) + '/chat/active-chatters');
      }

      for (const url of candidates) {
        try {
          const j = await kickGet(url);
          const n = countFrom(j);
          if (n == null) continue;
          ch.api = { n, ts: Date.now() };
          ch.apiFail = 0;
          ok = true;
          break;
        } catch (e) {
          /* try next candidate */
        }
      }
      if (!ok) {
        ch.apiFail = (ch.apiFail || 0) + 1;
        if (ch.apiFail >= 4) ch.apiOff = true;
      }
      await sleep(250);
    }
    render();
  }

  /* ---------- Range logic ---------- */

  function rangeFor(ch) {
    const now = Date.now();
    const floor = countRecent(ch.slug, now);
    const apiFresh = S.useApi && ch.api && now - ch.api.ts < Math.max(S.pollSec, 15) * 3000;
    let low = floor;
    let high = floor;
    if (apiFresh) {
      low = Math.min(floor, ch.api.n);
      high = Math.max(floor, ch.api.n);
    }
    if (ch.viewers > 0) {
      high = Math.min(high, ch.viewers);
      low = Math.min(low, high);
    }
    const warm = (ch.coveredFrom || now) > now - S.windowMin * 60000 + 5000;
    return { low, high, floor, api: apiFresh ? ch.api.n : null, warm };
  }

  const fmtRange = (r) => (r.low === r.high ? String(r.low) : r.low + '\u2013' + r.high);

  /* ---------- Icons ---------- */

  const ICON_USERS =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM9 13c-3.3 0-7 1.7-7 4v2h14v-2c0-2.3-3.7-4-7-4zm8 0c-.6 0-1.2.1-1.8.2 1.6 1 2.8 2.4 2.8 3.8v2h5v-2c0-2-3.2-4-6-4z"/></svg>';
  const ICON_EYE =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const ICON_OFFLINE =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/></svg>';
  const ICON_CHEVRON_DOWN =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  const ICON_CHEVRON_UP =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>';

  /* ---------- Sidebar Styles ---------- */

  const CSS = `
    :host {
      display: block;
      width: 100%;
      box-sizing: border-box;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #fff;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    .kfc-section {
      display: flex;
      flex-direction: column;
      width: 100%;
      padding-bottom: 6px;
      margin-bottom: 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    
    /* Section Header */
    .kfc-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px 6px;
      user-select: none;
    }
    .kfc-title-wrap {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .kfc-title {
      font-size: 14px;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: -0.01em;
    }
    .kfc-live-badge {
      display: inline-flex;
      align-items: center;
      gap: 4.5px;
      font-size: 11px;
      font-weight: 700;
      color: #53fc18;
      background: rgba(83, 252, 24, 0.12);
      border: 1px solid rgba(83, 252, 24, 0.28);
      padding: 1.5px 6.5px;
      border-radius: 999px;
      line-height: 1.3;
    }
    .kfc-live-badge i {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #53fc18;
      box-shadow: 0 0 5px #53fc18;
    }

    /* Mode Switcher Segmented Control */
    .kfc-mode-toggle {
      display: inline-flex;
      align-items: center;
      background: #101416;
      border: 1px solid #1f2529;
      border-radius: 6px;
      padding: 2px;
      gap: 2px;
    }
    .kfc-mode-btn {
      all: unset;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 2px 6px;
      height: 20px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      color: #727a82;
      border: 1px solid transparent;
      transition: all 0.12s ease;
    }
    .kfc-mode-btn:hover {
      color: #d0d4d8;
    }
    .kfc-mode-btn.active {
      background: #132b17;
      color: #53fc18;
      border-color: #1a4220;
    }
    .kfc-mode-btn:focus-visible {
      outline: 2px solid #53fc18;
      outline-offset: 1px;
    }

    /* Streamer List */
    .kfc-list {
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding: 0 6px;
    }
    .kfc-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 8px;
      border-radius: 6px;
      text-decoration: none;
      color: inherit;
      transition: background 0.12s ease;
      cursor: pointer;
    }
    .kfc-row:hover {
      background: #181c1f;
    }
    .kfc-row.current {
      background: #192024;
      box-shadow: inset 2px 0 0 #53fc18;
    }

    /* Avatar */
    .kfc-av {
      position: relative;
      flex: none;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #1d2226;
      overflow: hidden;
      display: grid;
      place-items: center;
      font-size: 13px;
      font-weight: 700;
      color: #8b929a;
    }
    .kfc-av img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .kfc-row.offline .kfc-av {
      opacity: 0.65;
      filter: grayscale(35%);
    }

    /* Meta text */
    .kfc-meta {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1.5px;
    }
    .kfc-name {
      font-size: 14px;
      font-weight: 700;
      color: #ffffff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.25;
    }
    .kfc-row.offline .kfc-name {
      color: #adb5bd;
      font-weight: 600;
    }
    .kfc-cat {
      font-size: 12px;
      font-weight: 500;
      color: #727a83;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.25;
    }

    /* Live & Offline Indicators */
    .kfc-status {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 13px;
      font-weight: 700;
      color: #53fc18;
      font-variant-numeric: tabular-nums;
    }
    .kfc-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #53fc18;
      display: block;
      box-shadow: 0 0 5px rgba(83, 252, 24, 0.7);
    }
    .kfc-status.warm {
      opacity: 0.75;
    }
    .kfc-offline-icon {
      flex: none;
      display: grid;
      place-items: center;
      color: #586068;
    }

    /* Show More Button */
    .kfc-toggle-wrap {
      padding: 3px 6px 2px;
    }
    .kfc-toggle-btn {
      all: unset;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 700;
      color: #6a7480;
      transition: color 0.12s ease, background 0.12s ease;
      width: 100%;
    }
    .kfc-toggle-btn:hover {
      color: #ffffff;
      background: #14181a;
    }
    .kfc-toggle-btn:focus-visible {
      outline: 2px solid #53fc18;
      outline-offset: 1px;
    }

    /* Empty state */
    .kfc-empty {
      padding: 16px 12px;
      color: #7d848c;
      font-size: 13px;
      line-height: 1.45;
      text-align: center;
    }

    /* Collapsed Sidebar Adaptation */
    :host(.kfc-collapsed-sidebar) .kfc-head,
    :host(.kfc-collapsed-sidebar) .kfc-meta,
    :host(.kfc-collapsed-sidebar) .kfc-status span,
    :host(.kfc-collapsed-sidebar) .kfc-offline-icon,
    :host(.kfc-collapsed-sidebar) .kfc-toggle-wrap {
      display: none !important;
    }
    :host(.kfc-collapsed-sidebar) .kfc-row {
      justify-content: center;
      padding: 6px 0;
      position: relative;
    }
    :host(.kfc-collapsed-sidebar) .kfc-av {
      width: 36px;
      height: 36px;
    }
    :host(.kfc-collapsed-sidebar) .kfc-status {
      position: absolute;
      top: 4px;
      right: calc(50% - 18px);
    }
  `;

  let host = null;
  let root = null;
  let renderQueued = false;
  let sidebarObserver = null;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------- DOM Mount & Native Suppression ---------- */

  function findSidebarContainer() {
    return (
      document.querySelector('[scrollable="true"]') ||
      document.querySelector('.no-scrollbar.overflow-y-auto') ||
      document.querySelector('aside [class*="overflow-y-auto"]') ||
      document.querySelector('nav [class*="overflow-y-auto"]') ||
      document.querySelector('aside .no-scrollbar')
    );
  }

  function suppressNativeFollowing(scrollable) {
    if (!scrollable) return;

    // Scan for native "Following" sections inside scrollable container
    const all = Array.from(scrollable.querySelectorAll('*'));
    for (const node of all) {
      if (node.id === 'kfc-host' || node.closest('#kfc-host')) continue;
      
      const txt = (node.textContent || '').trim();
      // Match text that starts with Following and is a section title or header
      if (txt === 'Following' && node.children.length === 0) {
        // Avoid top nav button
        if (node.closest('button[class*="group"]') && node.closest('a[href="/following"]')) continue;
        
        // Find top-level child of scrollable
        let section = node;
        while (section && section.parentElement !== scrollable && section !== scrollable) {
          section = section.parentElement;
        }

        if (section && section !== scrollable && !section.id?.startsWith('kfc')) {
          if (!section.textContent.includes('Recommended')) {
            section.setAttribute('data-kfc-native-hidden', 'true');
            section.style.setProperty('display', 'none', 'important');
            continue;
          }
        }

        // If elements are flat siblings inside scrollable
        let curr = node.parentElement === scrollable ? node : node.closest('div');
        while (curr && curr.parentElement === scrollable) {
          if (curr.textContent.includes('Recommended') || curr.id === 'kfc-host') break;
          curr.setAttribute('data-kfc-native-hidden', 'true');
          curr.style.setProperty('display', 'none', 'important');
          curr = curr.nextElementSibling;
        }
      }
    }
  }

  function mount() {
    const scrollable = findSidebarContainer();
    if (!scrollable) return false;

    suppressNativeFollowing(scrollable);

    if (!host) {
      host = document.createElement('div');
      host.id = 'kfc-host';
      root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);
    }

    // Insert at the top of scrollable container
    if (host.parentElement !== scrollable) {
      scrollable.insertBefore(host, scrollable.firstChild);
    } else if (scrollable.firstChild !== host) {
      scrollable.insertBefore(host, scrollable.firstChild);
    }

    // Check if Kick's sidebar is in collapsed icon-only mode (~60px)
    const isSidebarCollapsed = (host.offsetWidth > 0 && host.offsetWidth < 120) || (scrollable.offsetWidth > 0 && scrollable.offsetWidth < 120);
    if (isSidebarCollapsed) {
      host.classList.add('kfc-collapsed-sidebar');
    } else {
      host.classList.remove('kfc-collapsed-sidebar');
    }

    return true;
  }

  function setMode(mode) {
    S.mode = mode;
    chrome.storage.sync.set({ mode });
    render();
  }

  function toggleExpanded() {
    isExpanded = !isExpanded;
    chrome.storage.sync.set({ expanded: isExpanded });
    render();
  }

  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      render();
    }, 500);
  }

  /* ---------- Render ---------- */

  function render() {
    if (!mount()) {
      // Sidebar not in DOM yet; try again on next tick
      setTimeout(render, 300);
      return;
    }

    // Clear existing rendered content inside shadow root (keep the <style>)
    for (const child of [...root.childNodes]) {
      if (child.tagName !== 'STYLE') child.remove();
    }

    const section = el('div', 'kfc-section');

    const allChannels = [...channels.values()];
    const liveChannels = allChannels.filter((c) => c.live);
    const offlineChannels = allChannels.filter((c) => !c.live);

    // Sort live channels according to current mode
    const liveRows = liveChannels.map((ch) => ({ ch, r: rangeFor(ch) }));
    if (S.mode === 'chatters') {
      liveRows.sort((a, b) => b.r.high - a.r.high || b.r.low - a.r.low || b.ch.viewers - a.ch.viewers);
    } else {
      liveRows.sort((a, b) => b.ch.viewers - a.ch.viewers);
    }

    // Sort offline channels alphabetically by display name
    offlineChannels.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const combinedRows = [
      ...liveRows.map((x) => ({ ...x, isLive: true })),
      ...offlineChannels.map((ch) => ({ ch, r: null, isLive: false }))
    ];

    const liveCount = liveChannels.length;
    const totalCount = combinedRows.length;

    /* --- Section Header --- */
    const head = el('div', 'kfc-head');

    const titleWrap = el('div', 'kfc-title-wrap');
    titleWrap.appendChild(el('span', 'kfc-title', 'Following'));

    const liveBadge = el('span', 'kfc-live-badge');
    liveBadge.appendChild(el('i'));
    liveBadge.appendChild(document.createTextNode(liveCount + ' live'));
    titleWrap.appendChild(liveBadge);

    head.appendChild(titleWrap);

    // Segmented Mode Switcher (Chatters vs Viewers)
    const modeToggle = el('div', 'kfc-mode-toggle');

    const chatBtn = el('button', 'kfc-mode-btn' + (S.mode === 'chatters' ? ' active' : ''));
    chatBtn.innerHTML = ICON_USERS;
    chatBtn.title = 'Display active chatter range';
    chatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setMode('chatters');
    });

    const viewBtn = el('button', 'kfc-mode-btn' + (S.mode === 'viewers' ? ' active' : ''));
    viewBtn.innerHTML = ICON_EYE;
    viewBtn.title = 'Display official viewer count';
    viewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setMode('viewers');
    });

    modeToggle.appendChild(chatBtn);
    modeToggle.appendChild(viewBtn);
    head.appendChild(modeToggle);

    section.appendChild(head);

    /* --- Streamer List --- */
    const list = el('div', 'kfc-list');
    const currentSlug = location.pathname.split('/')[1]?.toLowerCase() || '';

    if (loginNeeded) {
      list.appendChild(el('div', 'kfc-empty', 'Log in to Kick to load your Following list.'));
      section.appendChild(list);
      root.appendChild(section);
      return;
    }

    if (!totalCount) {
      list.appendChild(
        el('div', 'kfc-empty', lastFollowOk ? 'None of your followed channels are available.' : 'Loading following list...')
      );
      section.appendChild(list);
      root.appendChild(section);
      return;
    }

    // Determine slice based on expanded state
    const initialLimit = S.initialCount || DEFAULT_INITIAL_COUNT;
    const visibleRows = isExpanded ? combinedRows : combinedRows.slice(0, initialLimit);

    for (const item of visibleRows) {
      const { ch, r, isLive } = item;
      const isCurrent = ch.slug === currentSlug;
      const row = el('a', 'kfc-row' + (isLive ? ' live' : ' offline') + (isCurrent ? ' current' : ''));
      row.href = '/' + ch.slug;

      // Avatar
      const av = el('div', 'kfc-av');
      if (ch.avatar) {
        const img = document.createElement('img');
        img.src = ch.avatar;
        img.alt = ch.name;
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => {
          img.remove();
          av.textContent = (ch.name || '?').charAt(0).toUpperCase();
        });
        av.appendChild(img);
      } else {
        av.textContent = (ch.name || '?').charAt(0).toUpperCase();
      }
      row.appendChild(av);

      // Meta: Name & Category
      const meta = el('div', 'kfc-meta');
      meta.appendChild(el('div', 'kfc-name', ch.name));
      meta.appendChild(el('div', 'kfc-cat', isLive ? ch.category || 'Live' : 'Offline'));
      row.appendChild(meta);

      // Right indicator
      if (isLive) {
        const isChat = S.mode === 'chatters';
        const status = el('div', 'kfc-status' + (isChat && r && r.warm && r.api == null ? ' warm' : ''));
        status.appendChild(el('i', 'kfc-dot'));
        const countText = isChat ? fmtRange(r) : ch.viewers.toLocaleString();
        status.appendChild(document.createTextNode(countText));
        row.appendChild(status);

        // Tooltip
        const tipLines = [
          ch.name + (ch.streamTitle ? ': ' + ch.streamTitle : ''),
          'Category: ' + (ch.category || 'Live'),
          'Viewers: ' + ch.viewers.toLocaleString(),
          'Chatted in last ' + S.windowMin + ' min: ' + (r ? r.floor : 0),
          r && r.api != null ? 'Kick active chatters API: ' + r.api : null,
          r && r.warm ? '(Collecting full window activity)' : null
        ].filter(Boolean);
        row.title = tipLines.join('\n');
      } else {
        const offlineIcon = el('div', 'kfc-offline-icon');
        offlineIcon.innerHTML = ICON_OFFLINE;
        row.appendChild(offlineIcon);
        row.title = ch.name + ' is offline';
      }

      list.appendChild(row);
    }

    section.appendChild(list);

    /* --- "Show More" / "Show Less" Control --- */
    if (totalCount > initialLimit) {
      const toggleWrap = el('div', 'kfc-toggle-wrap');
      const toggleBtn = el('button', 'kfc-toggle-btn');
      if (isExpanded) {
        toggleBtn.innerHTML = ICON_CHEVRON_UP + '<span>Show Less</span>';
        toggleBtn.title = 'Collapse Following list';
      } else {
        const remaining = totalCount - initialLimit;
        toggleBtn.innerHTML = ICON_CHEVRON_DOWN + '<span>Show More (' + remaining + ')</span>';
        toggleBtn.title = 'Show all ' + totalCount + ' followed channels';
      }
      toggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleExpanded();
      });
      toggleWrap.appendChild(toggleBtn);
      section.appendChild(toggleWrap);
    }

    root.appendChild(section);
  }

  /* ---------- SPA Route & DOM Observers ---------- */

  function setupObservers() {
    if (sidebarObserver) sidebarObserver.disconnect();

    sidebarObserver = new MutationObserver((mutations) => {
      let needsRecheck = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
          needsRecheck = true;
          break;
        }
      }
      if (needsRecheck) {
        const scrollable = findSidebarContainer();
        if (scrollable && (host == null || host.parentElement !== scrollable || scrollable.firstChild !== host)) {
          render();
        }
      }
    });

    sidebarObserver.observe(document.body, { childList: true, subtree: true });

    // Detect SPA client-side URL route changes
    let lastUrl = location.href;
    const urlCheck = setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(render, 300);
      }
    }, 600);
    timers.push(urlCheck);
  }

  /* ---------- Boot & Timers ---------- */

  function startTimers() {
    timers.forEach(clearInterval);
    const every = Math.max(15, Number(S.pollSec) || 30) * 1000;
    timers = [
      setInterval(refreshFollowed, every),
      setInterval(pollApi, every),
      setInterval(render, 5000),
      setInterval(prune, 15000),
      setInterval(heartbeat, 20000),
      setInterval(() => {
        for (const ch of channels.values()) ch.apiOff = false;
      }, 600000)
    ];
    setupObservers();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    let restart = false;
    for (const [k, v] of Object.entries(changes)) {
      S[k] = v.newValue;
      if (k === 'expanded') isExpanded = !!v.newValue;
      if (k === 'pollSec') restart = true;
    }
    if (restart) startTimers();
    render();
  });

  chrome.storage.sync.get(DEFAULTS, async (saved) => {
    S = { ...DEFAULTS, ...saved };
    isExpanded = !!S.expanded;
    const local = await chrome.storage.local.get({ idCache: {} });
    idCache = local.idCache || {};
    render();
    wsConnect();
    startTimers();
    await refreshFollowed();
    pollApi();
  });
})();
