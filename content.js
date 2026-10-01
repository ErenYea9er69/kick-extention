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
    showDeletedMessages: true,
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

  // Deleted chat messages state
  let currentViewingSlug = null;
  let currentViewingChatroomId = null;
  let chatContainer = null;
  let chatObserver = null;
  let chatStylesInjected = false;
  const deletedMsgIds = new Set();
  const bannedUsers = new Set();
  const domMsgMap = new Map();
  const recentMessagesMap = new Map();

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

  const DELETED_EVENT_NAMES = new Set([
    'App\\Events\\MessageDeletedEvent',
    'MessageDeletedEvent',
    'App\\Events\\ChatMessageDeletedEvent',
    'ChatMessageDeletedEvent',
    'message.deleted'
  ]);

  const BAN_EVENT_NAMES = new Set([
    'App\\Events\\UserBannedEvent',
    'UserBannedEvent',
    'App\\Events\\UserTimedOutEvent',
    'UserTimedOutEvent',
    'App\\Events\\BannedUserEvent',
    'user.banned'
  ]);

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
    } else if (DELETED_EVENT_NAMES.has(m.event)) {
      onMessageDeleted(m);
    } else if (BAN_EVENT_NAMES.has(m.event)) {
      onUserBanned(m);
    }
  }

  function onMessageDeleted(m) {
    let d;
    try {
      d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data;
    } catch (e) {
      return;
    }
    const msgId = (d && (d.message?.id || d.id)) || null;
    if (msgId) {
      const idStr = String(msgId);
      deletedMsgIds.add(idStr);
      if (deletedMsgIds.size > 2000) {
        const oldest = deletedMsgIds.values().next().value;
        deletedMsgIds.delete(oldest);
      }
      markDeletedInDomById(idStr);
    }
  }

  function onUserBanned(m) {
    let d;
    try {
      d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data;
    } catch (e) {
      return;
    }
    const username = (d && (d.user?.username || d.username)) || null;
    if (username) {
      const u = String(username).toLowerCase();
      bannedUsers.add(u);
      if (bannedUsers.size > 1000) {
        const oldest = bannedUsers.values().next().value;
        bannedUsers.delete(oldest);
      }
      markDeletedInDomByUser(u);
    }
  }

  function onChat(m) {
    const room = /^chatrooms\.(\d+)\.v2$/.exec(m.channel || '');
    if (!room) return;
    const chatroomId = Number(room[1]);
    const slug = roomToSlug.get(chatroomId);
    let d;
    try {
      d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data;
    } catch (e) {
      return;
    }
    const u = d && d.sender;
    if (slug && u) {
      record(slug, u.id != null ? String(u.id) : String(u.username).toLowerCase(), u.username, Date.now());
      requestRender();
    }
    if (d && d.id) {
      const msgId = String(d.id);
      const senderName = (u && u.username) ? String(u.username).toLowerCase() : '';
      recentMessagesMap.set(msgId, {
        id: msgId,
        user: senderName,
        content: d.content || '',
        ts: Date.now()
      });
      if (recentMessagesMap.size > 1000) {
        const oldestKey = recentMessagesMap.keys().next().value;
        recentMessagesMap.delete(oldestKey);
      }
    }
  }

  async function updateCurrentViewingChannel() {
    const pathParts = location.pathname.split('/').filter(Boolean);
    const first = (pathParts[0] || '').toLowerCase();
    const reserved = new Set([
      '', 'categories', 'browse', 'following', 'settings', 'dashboard',
      'terms', 'privacy', 'community-guidelines', 'dmca', 'search',
      'video', 'clip', 'help', 'subscriptions'
    ]);
    if (!first || reserved.has(first)) {
      currentViewingSlug = null;
      currentViewingChatroomId = null;
      return;
    }
    if (currentViewingSlug === first && currentViewingChatroomId) return;
    currentViewingSlug = first;

    // Check if channel is in followed list
    const followed = channels.get(first);
    if (followed && followed.chatroomId) {
      currentViewingChatroomId = followed.chatroomId;
      roomToSlug.set(Number(currentViewingChatroomId), first);
      syncSubs();
      return;
    }

    // Check idCache
    if (idCache[first] && idCache[first].chatroomId) {
      currentViewingChatroomId = idCache[first].chatroomId;
      roomToSlug.set(Number(currentViewingChatroomId), first);
      syncSubs();
      return;
    }

    // Fetch from Kick API
    try {
      const j = await kickGet('/api/v2/channels/' + encodeURIComponent(first));
      if (j && j.chatroom && j.chatroom.id) {
        currentViewingChatroomId = j.chatroom.id;
        idCache[first] = { channelId: j.id, chatroomId: j.chatroom.id };
        roomToSlug.set(Number(currentViewingChatroomId), first);
        chrome.storage.local.set({ idCache });
        syncSubs();
      }
    } catch (e) {
      /* retry later */
    }
  }

  function syncSubs() {
    if (!ws.ready) return;
    const want = new Map();
    // 1. Followed live channels
    for (const ch of channels.values()) {
      if (ch.live && ch.chatroomId && want.size < MAX_ROOMS) {
        want.set('chatrooms.' + ch.chatroomId + '.v2', ch);
      }
    }
    // 2. Currently viewed channel chatroom (ensures we catch deletions on whatever channel user is watching)
    if (currentViewingChatroomId) {
      const currentChName = 'chatrooms.' + currentViewingChatroomId + '.v2';
      want.set(currentChName, { slug: currentViewingSlug, chatroomId: currentViewingChatroomId });
    }
    for (const [name, ch] of want) {
      if (ws.subs.has(name)) continue;
      ws.subs.add(name);
      if (ch && ch.subAt !== undefined) {
        ch.subAt = Date.now();
        ch.coveredFrom = Date.now();
        seedHistory(ch);
      }
      wsSend({ event: 'pusher:subscribe', data: { auth: '', channel: name } });
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

  function injectGlobalStyles() {
    if (document.getElementById('kfc-global-styles')) return;
    const s = document.createElement('style');
    s.id = 'kfc-global-styles';
    s.textContent = `
      [data-kfc-native-hidden] {
        display: none !important;
        visibility: hidden !important;
        height: 0px !important;
        min-height: 0px !important;
        max-height: 0px !important;
        margin: 0px !important;
        padding: 0px !important;
        border: none !important;
        overflow: hidden !important;
        pointer-events: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  function hideAndRemove(el) {
    if (!el || el.id === 'kfc-host' || el.closest('#kfc-host')) return;
    el.setAttribute('data-kfc-native-hidden', 'true');
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('height', '0px', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
    try {
      el.remove();
    } catch (e) {}
  }

  function suppressNativeFollowing() {
    injectGlobalStyles();

    const aside = document.querySelector('aside') || document.body;
    if (!aside) return;

    // 1. Find native "Following" section header in aside (not the top nav /following link, not in #kfc-host)
    const allElements = aside.querySelectorAll('button, div, span, h2, h3, p');
    let headerEl = null;
    for (const el of allElements) {
      if (el.id === 'kfc-host' || el.closest('#kfc-host')) continue;
      if (el.tagName === 'A' && el.getAttribute('href') === '/following') continue;
      if (el.closest('a[href="/following"]')) continue;

      const txt = (el.textContent || '').trim();
      if (txt === 'Following' || txt === 'FOLLOWING') {
        if (!txt.includes('Home') && !txt.includes('Browse') && !txt.includes('live')) {
          headerEl = el;
          break;
        }
      }
    }

    if (headerEl) {
      const container = headerEl.closest('[scrollable="true"]') || headerEl.closest('aside') || headerEl.parentElement;
      let sectionItem = headerEl;
      while (sectionItem && sectionItem.parentElement && sectionItem.parentElement !== container) {
        sectionItem = sectionItem.parentElement;
      }

      let curr = sectionItem;
      let count = 0;
      while (curr && curr.parentElement === container) {
        if (count > 0 && (curr.textContent || '').includes('Recommended')) {
          break; // Stop at Recommended
        }
        const next = curr.nextElementSibling;
        hideAndRemove(curr);
        count++;
        curr = next;
      }
    }

    // 2. Direct scan inside scrollable container
    const scrollable = findSidebarContainer();
    if (scrollable) {
      const children = Array.from(scrollable.children);
      const recIndex = children.findIndex((c) => {
        if (c.id === 'kfc-host') return false;
        const txt = (c.textContent || '').trim();
        return txt.includes('Recommended') && !txt.includes('Following');
      });

      let inNativeFollowing = false;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.id === 'kfc-host') continue;

        const txt = (child.textContent || '').trim();
        if (recIndex !== -1 && i >= recIndex) break;
        if (txt.includes('Recommended') && !txt.includes('Following')) break;

        if (txt.includes('Following') && !txt.includes('live')) {
          inNativeFollowing = true;
        }

        if (recIndex !== -1 || inNativeFollowing) {
          hideAndRemove(child);
        }
      }
    }

    // 3. Scan for any stray streamer cards or "Show More" buttons in aside that appear before Recommended
    const strayCards = aside.querySelectorAll('button.group, a[href^="/"]');
    for (const card of strayCards) {
      if (card.id === 'kfc-host' || card.closest('#kfc-host')) continue;
      // Do not touch top nav links
      const href = card.getAttribute('href') || card.querySelector('a')?.getAttribute('href') || '';
      if (href === '/' || href === '/browse' || href === '/following' || href.startsWith('/category')) continue;

      // Check if this card appears before Recommended
      let isAfterRecommended = false;
      let check = card;
      while (check && check !== aside) {
        let prev = check.previousElementSibling;
        while (prev) {
          if (prev.textContent && prev.textContent.includes('Recommended')) {
            isAfterRecommended = true;
            break;
          }
          prev = prev.previousElementSibling;
        }
        if (isAfterRecommended) break;
        check = check.parentElement;
      }

      // If it's in the sidebar before Recommended (or if no Recommended section exists), it's a native Following card!
      if (!isAfterRecommended) {
        const rowWrapper = card.closest('button.group') || card;
        hideAndRemove(rowWrapper);
      }
    }
  }

  function mount() {
    const scrollable = findSidebarContainer();
    if (!scrollable) return false;

    suppressNativeFollowing();

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

    suppressNativeFollowing();

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

  /* ---------- Show Deleted Chat Messages Feature ---------- */

  function injectChatStyles() {
    if (chatStylesInjected || document.getElementById('kfc-chat-styles')) {
      chatStylesInjected = true;
      return;
    }
    const style = document.createElement('style');
    style.id = 'kfc-chat-styles';
    style.textContent = `
      .kfc-deleted-msg {
        position: relative !important;
        background: rgba(239, 68, 68, 0.12) !important;
        border-left: 3px solid #ef4444 !important;
        padding-left: 6px !important;
        margin-left: -3px !important;
        opacity: 0.85 !important;
        border-radius: 2px !important;
        transition: background 0.15s ease, opacity 0.15s ease !important;
      }
      .kfc-deleted-msg:hover {
        background: rgba(239, 68, 68, 0.22) !important;
        opacity: 1 !important;
      }
      .kfc-deleted-badge {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        font-size: 9px !important;
        font-weight: 800 !important;
        letter-spacing: 0.05em !important;
        text-transform: uppercase !important;
        color: #ff6b6b !important;
        background: rgba(239, 68, 68, 0.24) !important;
        border: 1px solid rgba(239, 68, 68, 0.55) !important;
        border-radius: 3px !important;
        padding: 1px 4px !important;
        margin-right: 5px !important;
        line-height: 1.2 !important;
        user-select: none !important;
        vertical-align: middle !important;
      }
      .kfc-deleted-text,
      .kfc-deleted-msg > span:last-of-type,
      .kfc-deleted-msg .break-words {
        text-decoration: line-through !important;
        text-decoration-color: rgba(239, 68, 68, 0.85) !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
    chatStylesInjected = true;
  }

  function extractUsername(node) {
    if (!node || node.nodeType !== 1) return '';
    const btn = node.querySelector('button.font-bold, button[class*="font-bold"]');
    if (btn && btn.textContent) return btn.textContent.trim();
    const anyBtn = node.querySelector('button');
    if (anyBtn && anyBtn.textContent && anyBtn.textContent.length < 30) return anyBtn.textContent.trim();
    return '';
  }

  function extractMessageId(node) {
    if (!node || node.nodeType !== 1) return null;
    if (node.dataset?.kfcMsgId) return node.dataset.kfcMsgId;
    try {
      const fiberKey = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (fiberKey) {
        let curr = node[fiberKey];
        let depth = 0;
        while (curr && depth < 10) {
          const p = curr.memoizedProps;
          if (p) {
            if (p.message?.id) return String(p.message.id);
            if (p.chatMessage?.id) return String(p.chatMessage.id);
            if (p.id && typeof p.id === 'string' && p.id.length > 10) return String(p.id);
          }
          curr = curr.return;
          depth++;
        }
      }
    } catch (e) {}
    return null;
  }

  function applyDeletedStyle(node) {
    if (!node || node.nodeType !== 1) return;
    node.dataset.kfcDeleted = 'true';
    node.setAttribute('data-kfc-deleted', 'true');
    node.classList.add('kfc-deleted-msg');

    // Strike-through on message text spans
    const textSpans = node.querySelectorAll('span:not(.kfc-deleted-badge)');
    for (const span of textSpans) {
      if (!span.querySelector('button') && span.textContent.trim().length > 0) {
        span.classList.add('kfc-deleted-text');
      }
    }

    // Add [DELETED] badge if not already present
    if (!node.querySelector('.kfc-deleted-badge')) {
      const badge = document.createElement('span');
      badge.className = 'kfc-deleted-badge';
      badge.textContent = 'DELETED';
      badge.title = 'This message was deleted by a moderator/bot';

      const userBtn = node.querySelector('button.font-bold, button[class*="font-bold"], button');
      if (userBtn && userBtn.parentElement) {
        userBtn.parentElement.insertBefore(badge, userBtn);
      } else {
        node.insertBefore(badge, node.firstChild);
      }
    }
  }

  function tagChatMessageNode(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.dataset?.kfcTagged === 'true') return;
    node.dataset.kfcTagged = 'true';

    // Save snapshot of original innerHTML in case Kick modifies text in-place
    node._kfcOriginalHtml = node.innerHTML;

    const user = extractUsername(node);
    if (user) {
      node.dataset.kfcUser = user.toLowerCase();
    }

    const msgId = extractMessageId(node);
    if (msgId) {
      node.dataset.kfcMsgId = msgId;
      domMsgMap.set(msgId, node);
      if (domMsgMap.size > 2000) {
        const oldest = domMsgMap.keys().next().value;
        domMsgMap.delete(oldest);
      }
    }

    // If message is already marked as deleted or sender is banned, apply styling immediately
    if ((msgId && deletedMsgIds.has(msgId)) || (user && bannedUsers.has(user.toLowerCase()))) {
      applyDeletedStyle(node);
    }
  }

  function markDeletedInDomById(msgId) {
    const node = domMsgMap.get(msgId);
    if (node && node.parentNode) {
      applyDeletedStyle(node);
    }
  }

  function markDeletedInDomByUser(username) {
    if (!chatContainer) return;
    const lower = username.toLowerCase();
    for (const child of chatContainer.children) {
      if (child.nodeType === 1 && child.dataset?.kfcUser === lower) {
        applyDeletedStyle(child);
      }
    }
  }

  function preserveDeletedMessage(node, mutation, container) {
    applyDeletedStyle(node);

    try {
      if (mutation.nextSibling && mutation.nextSibling.parentNode === container) {
        container.insertBefore(node, mutation.nextSibling);
      } else if (mutation.previousSibling && mutation.previousSibling.parentNode === container) {
        container.insertBefore(node, mutation.previousSibling.nextSibling);
      } else {
        container.appendChild(node);
      }
    } catch (e) {
      try {
        container.appendChild(node);
      } catch (e2) {}
    }
  }

  function handleRemovedChatNodes(mutation, container) {
    if (!S.showDeletedMessages) return;

    for (const node of mutation.removedNodes) {
      if (node.nodeType !== 1) continue;

      // Avoid re-inserting already-preserved deleted messages when chat buffer cleans them up
      if (node.dataset?.kfcDeleted === 'true') continue;

      const user = node.dataset?.kfcUser || extractUsername(node);
      const msgId = node.dataset?.kfcMsgId || extractMessageId(node);

      const isBanned = user && bannedUsers.has(user.toLowerCase());
      const isDeletedId = msgId && deletedMsgIds.has(msgId);

      // Natural FIFO scroll pruning check:
      // Kick prunes from the very top (index 0) when chat buffer has >= 50 messages.
      // If it wasn't explicitly banned or deleted by ID and it's index 0 prune, let it go.
      const isFifoPrune = mutation.previousSibling === null && container.children.length >= 50 && !isBanned && !isDeletedId;

      if (isFifoPrune) {
        if (msgId) domMsgMap.delete(msgId);
        continue;
      }

      // Preserving deleted message
      preserveDeletedMessage(node, mutation, container);
    }
  }

  function ensureChatObserver() {
    if (!S.showDeletedMessages) {
      if (chatObserver) {
        chatObserver.disconnect();
        chatObserver = null;
        chatContainer = null;
      }
      return;
    }

    injectChatStyles();

    const container = document.getElementById('chatroom-messages');
    if (!container) {
      chatContainer = null;
      return;
    }

    if (container === chatContainer && chatObserver) {
      return;
    }

    if (chatObserver) {
      chatObserver.disconnect();
    }

    chatContainer = container;

    // Tag existing messages
    for (const child of container.children) {
      if (child.nodeType === 1) tagChatMessageNode(child);
    }

    chatObserver = new MutationObserver((mutations) => {
      if (!S.showDeletedMessages) return;
      for (const m of mutations) {
        if (m.type === 'childList') {
          if (m.addedNodes.length > 0) {
            for (const node of m.addedNodes) {
              if (node.nodeType === 1) tagChatMessageNode(node);
            }
          }
          if (m.removedNodes.length > 0) {
            handleRemovedChatNodes(m, container);
          }
        }
      }
    });

    chatObserver.observe(container, { childList: true });
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
        suppressNativeFollowing();
        ensureChatObserver();
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
        suppressNativeFollowing();
        updateCurrentViewingChannel();
        ensureChatObserver();
        setTimeout(render, 300);
      }
    }, 400);
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
      setInterval(suppressNativeFollowing, 250),
      setInterval(ensureChatObserver, 1000),
      setInterval(updateCurrentViewingChannel, 3000),
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
      if (k === 'showDeletedMessages') {
        if (!v.newValue) {
          if (chatObserver) {
            chatObserver.disconnect();
            chatObserver = null;
            chatContainer = null;
          }
          document.querySelectorAll('.kfc-deleted-msg').forEach((el) => el.remove());
        } else {
          ensureChatObserver();
        }
      }
    }
    if (restart) startTimers();
    render();
  });

  chrome.storage.sync.get(DEFAULTS, async (saved) => {
    S = { ...DEFAULTS, ...saved };
    isExpanded = !!S.expanded;
    const local = await chrome.storage.local.get({ idCache: {} });
    idCache = local.idCache || {};
    injectChatStyles();
    ensureChatObserver();
    updateCurrentViewingChannel();
    render();
    wsConnect();
    startTimers();
    await refreshFollowed();
    pollApi();
  });
})();
