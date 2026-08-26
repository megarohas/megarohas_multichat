'use strict';
// Twitch chat source: anonymous read-only IRC over TLS (justinfan login, no OAuth).
// Also pulls BTTV / FFZ / 7TV emote lists (public APIs, no keys) so third-party
// emotes render as images instead of bare words.
const tls = require('tls');

const IRC_HOST = 'irc.chat.twitch.tv';
const IRC_PORT = 6697;
const EMOTE_CDN = id => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;

// badge name -> normalized role
const BADGE_ROLES = {
  broadcaster: 'owner',
  moderator: 'mod',
  vip: 'vip',
  subscriber: 'sub',
  founder: 'sub',
  partner: 'verified',
  staff: 'staff',
  admin: 'staff',
  global_mod: 'staff',
};

const USERNOTICE_SYSTEM = new Set([
  'sub', 'resub', 'subgift', 'submysterygift', 'anonsubgift', 'giftpaidupgrade',
  'primepaidupgrade', 'raid', 'bitsbadgetier', 'viewermilestone', 'modiversary',
]);

const RESERVED_SEGMENTS = new Set([
  'videos', 'directory', 'subscriptions', 'subs', 'collections', 'clip', 'clips',
  'settings', 'wallet', 'drops', 'search', 'friends', 'jobs', 'p', 'downloads',
  'store', 'turbo', 'login', 'signup',
]);

function unescapeTag(v) {
  if (!v) return '';
  return v.replace(/\\(.?)/g, (_, c) => {
    if (c === 's') return ' ';
    if (c === ':') return ';';
    if (c === 'r') return '\r';
    if (c === 'n') return '\n';
    if (c === '\\') return '\\';
    return c;
  });
}

function parseLine(line) {
  let rest = line;
  const tags = {};
  if (rest[0] === '@') {
    const i = rest.indexOf(' ');
    for (const kv of rest.slice(1, i).split(';')) {
      const eq = kv.indexOf('=');
      if (eq === -1) tags[kv] = '';
      else tags[kv.slice(0, eq)] = unescapeTag(kv.slice(eq + 1));
    }
    rest = rest.slice(i + 1);
  }
  let prefix = null;
  if (rest[0] === ':') {
    const i = rest.indexOf(' ');
    prefix = rest.slice(1, i);
    rest = rest.slice(i + 1);
  }
  let trailing = null;
  let middle = rest;
  const ti = rest.indexOf(' :');
  if (ti !== -1) {
    trailing = rest.slice(ti + 2);
    middle = rest.slice(0, ti);
  }
  const params = middle.split(' ').filter(Boolean);
  const cmd = params.shift() || '';
  return { tags, prefix, cmd, params, trailing };
}

// The emotes/gifs tags use Unicode CODE POINT offsets (inclusive), so all
// slicing below works on an array of code points, never on raw JS string indices.
function collectRanges(tags, cps) {
  const ranges = [];
  if (tags.emotes) {
    for (const grp of tags.emotes.split('/')) {
      const c = grp.indexOf(':');
      if (c === -1) continue;
      const id = grp.slice(0, c);
      for (const r of grp.slice(c + 1).split(',')) {
        const [s, e] = r.split('-').map(Number);
        if (Number.isFinite(s) && Number.isFinite(e) && e >= s && s < cps.length) {
          ranges.push({ s, e: Math.min(e, cps.length - 1), url: EMOTE_CDN(id) });
        }
      }
    }
  }
  if (tags.gifs) {
    // <start>-<end>|<gifID>|<gifURL>, comma-separated; the URL must be used verbatim
    for (const grp of tags.gifs.split(',')) {
      const bits = grp.split('|');
      if (bits.length < 3) continue;
      const [s, e] = bits[0].split('-').map(Number);
      const url = bits.slice(2).join('|');
      if (Number.isFinite(s) && Number.isFinite(e) && e >= s && s < cps.length && /^https:\/\//.test(url)) {
        ranges.push({ s, e: Math.min(e, cps.length - 1), url });
      }
    }
  }
  return ranges.sort((a, b) => a.s - b.s);
}

// Split a plain-text chunk on third-party emote words (BTTV/FFZ/7TV).
function pushTextWithExt(parts, text, extMap) {
  if (!extMap || !extMap.size) {
    if (text) parts.push({ t: 'text', v: text });
    return;
  }
  let buf = '';
  for (const tok of text.split(/(\s+)/)) {
    const url = /\S/.test(tok) ? extMap.get(tok) : null;
    if (url) {
      if (buf) { parts.push({ t: 'text', v: buf }); buf = ''; }
      parts.push({ t: 'emote', url, alt: tok });
    } else {
      buf += tok;
    }
  }
  if (buf) parts.push({ t: 'text', v: buf });
}

function buildParts(text, tags, extMap) {
  const cps = Array.from(text);
  const ranges = collectRanges(tags, cps);
  const parts = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.s < pos) continue; // overlapping/bogus range
    if (r.s > pos) pushTextWithExt(parts, cps.slice(pos, r.s).join(''), extMap);
    parts.push({ t: 'emote', url: r.url, alt: cps.slice(r.s, r.e + 1).join('') });
    pos = r.e + 1;
  }
  if (pos < cps.length) pushTextWithExt(parts, cps.slice(pos).join(''), extMap);
  return parts;
}

function rolesFromBadges(badgesTag) {
  const roles = [];
  if (!badgesTag) return roles;
  for (const b of badgesTag.split(',')) {
    const role = BADGE_ROLES[b.split('/')[0]];
    if (role && !roles.includes(role)) roles.push(role);
  }
  return roles;
}

// ---------- third-party emotes (public endpoints, all optional) ----------
async function getJson(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

function normUrl(u) {
  if (!u) return null;
  if (u.startsWith('//')) u = 'https:' + u;
  return /^https:\/\//.test(u) ? u : null;
}

let globalExtPromise = null;
async function loadGlobalExt() {
  if (!globalExtPromise) globalExtPromise = (async () => {
    const map = new Map();
    const jobs = [
      getJson('https://api.betterttv.net/3/cached/emotes/global').then(list => {
        for (const e of list) map.set(e.code, `https://cdn.betterttv.net/emote/${e.id}/2x`);
      }),
      getJson('https://api.frankerfacez.com/v1/set/global').then(j => {
        for (const setId of j.default_sets || []) {
          for (const e of (j.sets && j.sets[setId] && j.sets[setId].emoticons) || []) {
            const u = normUrl(e.urls && (e.urls['2'] || e.urls['1']));
            if (u) map.set(e.name, u);
          }
        }
      }),
      getJson('https://7tv.io/v3/emote-sets/global').then(j => {
        for (const e of j.emotes || []) map.set(e.name, `https://cdn.7tv.app/emote/${e.id}/2x.webp`);
      }),
    ];
    await Promise.allSettled(jobs);
    return map;
  })();
  return globalExtPromise;
}

async function loadChannelExt(roomId) {
  const map = new Map();
  const jobs = [
    getJson(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`).then(j => {
      for (const e of [...(j.channelEmotes || []), ...(j.sharedEmotes || [])]) {
        map.set(e.code, `https://cdn.betterttv.net/emote/${e.id}/2x`);
      }
    }),
    getJson(`https://api.frankerfacez.com/v1/room/id/${roomId}`).then(j => {
      for (const set of Object.values(j.sets || {})) {
        for (const e of set.emoticons || []) {
          const u = normUrl(e.urls && (e.urls['2'] || e.urls['1']));
          if (u) map.set(e.name, u);
        }
      }
    }),
    getJson(`https://7tv.io/v3/users/twitch/${roomId}`).then(j => {
      for (const e of (j.emote_set && j.emote_set.emotes) || []) {
        map.set(e.name, `https://cdn.7tv.app/emote/${e.id}/2x.webp`);
      }
    }),
  ];
  await Promise.allSettled(jobs);
  return map;
}

// ---------- the IRC client ----------
class TwitchSource {
  // handlers: { onMessage(msg), onRemove(id), onRemoveAuthor(key), onClear(), onStatus(state, detail) }
  constructor(channel, handlers) {
    this.channel = channel.toLowerCase();
    this.h = handlers;
    this.sock = null;
    this.buf = '';
    this.stopped = false;
    this.attempts = 0;
    this.lastData = 0;
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this.extEmotes = null;   // Map(code -> url) or null until loaded
    this.extLoaded = false;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.keepaliveTimer);
    if (this.sock) { this.sock.destroy(); this.sock = null; }
  }

  _connect() {
    if (this.stopped) return;
    this.h.onStatus('connecting', 'подключение к чату Twitch…');
    this.buf = '';
    const sock = tls.connect({ host: IRC_HOST, port: IRC_PORT, servername: IRC_HOST });
    this.sock = sock;
    sock.setEncoding('utf8');

    sock.on('secureConnect', () => {
      this.lastData = Date.now();
      const nick = 'justinfan' + Math.floor(10000 + Math.random() * 80000);
      sock.write(`CAP REQ :twitch.tv/tags twitch.tv/commands\r\nNICK ${nick}\r\nJOIN #${this.channel}\r\n`);
    });

    sock.on('data', chunk => {
      this.lastData = Date.now();
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\r\n')) !== -1) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        if (line) { try { this._handle(line); } catch (e) { /* keep the stream alive on a bad line */ } }
      }
    });

    const onGone = () => {
      if (this.sock !== sock) return;
      this.sock = null;
      clearInterval(this.keepaliveTimer);
      this._scheduleReconnect();
    };
    sock.on('error', onGone);
    sock.on('close', onGone);

    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      if (!this.sock) return;
      if (Date.now() - this.lastData > 300000) { this.sock.destroy(); return; }
      try { this.sock.write('PING :keepalive\r\n'); } catch (e) {}
    }, 240000);
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempts, 5)) + Math.random() * 500;
    this.attempts++;
    this.h.onStatus('connecting', 'переподключение…');
    this.reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _loadExtEmotes(roomId) {
    if (this.extLoaded || !roomId) return;
    this.extLoaded = true;
    (async () => {
      const g = await loadGlobalExt();
      const c = await loadChannelExt(roomId);
      if (!this.stopped) this.extEmotes = new Map([...g, ...c]);
    })().catch(() => {});
  }

  _handle(line) {
    const m = parseLine(line);
    switch (m.cmd) {
      case 'PING':
        this.sock.write(`PONG :${m.trailing || 'tmi.twitch.tv'}\r\n`);
        return;
      case '366': // end of NAMES -> joined
        this.attempts = 0;
        this.h.onStatus('live', '');
        return;
      case 'ROOMSTATE':
        this._loadExtEmotes(m.tags['room-id']);
        return;
      case 'PRIVMSG':
        this._privmsg(m);
        return;
      case 'USERNOTICE':
        this._usernotice(m);
        return;
      case 'CLEARMSG':
        if (m.tags['target-msg-id']) this.h.onRemove('tw:' + m.tags['target-msg-id']);
        return;
      case 'CLEARCHAT':
        if (m.trailing) this.h.onRemoveAuthor(m.trailing.toLowerCase());
        else this.h.onClear();
        return;
      case 'RECONNECT':
        if (this.sock) this.sock.destroy();
        return;
      case 'NOTICE':
        if (m.trailing && /login/i.test(m.trailing)) this.h.onStatus('error', m.trailing);
        return;
    }
  }

  // source-id (Shared Chat) first, so the same message mirrored into two joined
  // channels collapses into one on the overlay.
  _msgId(m, suffix = '') {
    return 'tw:' + (m.tags['source-id'] || m.tags.id || Math.random().toString(36).slice(2)) + suffix;
  }

  _author(m) {
    // USERNOTICE has prefix tmi.twitch.tv and carries the login in a tag
    const login = m.tags.login || (m.prefix && m.prefix.includes('!') ? m.prefix.split('!')[0] : '');
    return {
      name: m.tags['display-name'] || login,
      color: m.tags.color || null,
      roles: rolesFromBadges(m.tags.badges),
      key: login,
    };
  }

  _privmsg(m) {
    let text = m.trailing || '';
    let action = false;
    if (text.startsWith('\x01ACTION ') && text.endsWith('\x01')) {
      action = true;
      text = text.slice(8, -1);
    }
    this.h.onMessage({
      id: this._msgId(m),
      kind: 'chat',
      author: this._author(m),
      parts: buildParts(text, m.tags, this.extEmotes),
      action,
      firstMsg: m.tags['first-msg'] === '1',
    });
  }

  _usernotice(m) {
    const msgId = m.tags['msg-id'];
    if (msgId === 'announcement') {
      if (m.trailing) this._privmsg(m);
      return;
    }
    if (!USERNOTICE_SYSTEM.has(msgId)) return;
    const sys = m.tags['system-msg'];
    if (sys) {
      this.h.onMessage({
        id: this._msgId(m),
        kind: 'system',
        author: this._author(m),
        parts: [],
        system: sys,
      });
    }
    if (m.trailing) {
      this.h.onMessage({
        id: this._msgId(m, ':msg'),
        kind: 'chat',
        author: this._author(m),
        parts: buildParts(m.trailing, m.tags, this.extEmotes),
      });
    }
  }
}

// twitch.tv/name, /popout/name/chat, /moderator/name, /embed/name/chat,
// m.twitch.tv/name, dashboard.twitch.tv/u/name/..., player.twitch.tv/?channel=name
function channelFromUrl(url) {
  let u;
  try { u = new URL(/^https?:/i.test(url) ? url : 'https://' + url); } catch (e) { return null; }
  if (!/(^|\.)twitch\.tv$/i.test(u.hostname)) return null;
  let login = null;
  if (u.hostname.toLowerCase() === 'player.twitch.tv') {
    login = u.searchParams.get('channel');
  } else {
    const seg = u.pathname.split('/').filter(Boolean);
    if (!seg.length) return null;
    login = seg[0];
    if (['popout', 'moderator', 'embed', 'u'].includes(login.toLowerCase()) && seg[1]) login = seg[1];
    else if (RESERVED_SEGMENTS.has(login.toLowerCase())) return null;
  }
  if (!login) return null;
  login = login.toLowerCase();
  return /^[a-z0-9_]{2,25}$/.test(login) ? login : null;
}

module.exports = { TwitchSource, channelFromUrl };
