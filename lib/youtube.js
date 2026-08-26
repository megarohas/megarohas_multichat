'use strict';
// YouTube live chat source: reads the public live chat the same way the web
// chat does — InnerTube get_live_chat polling. No API key, no OAuth.
//
// Flow (matches what chat-downloader/yt-dlp/youtube-chat-next do as of 2026):
//   1. resolve any URL form -> videoId (channel links via /live + canonical)
//   2. GET /watch?v=ID  -> INNERTUBE_API_KEY, clientVersion, and the
//      conversationBar reload continuation (the only watch-page token the API
//      still accepts since the Oct 2025 change)
//   3. GET /live_chat?continuation=<token> -> per-view tokens (index 0 = Top
//      chat, index 1 = Live chat/all messages; select by index, titles are
//      localized) + the first batch of messages
//   4. POST /youtubei/v1/live_chat/get_live_chat in a self-scheduling loop,
//      honoring timeoutMs clamped to [1000, 8000]

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const COOKIE = 'SOCS=CAI';
const ORIGIN = 'https://www.youtube.com';

const VIDEO_ID_RE = [
  /[?&]v=([A-Za-z0-9_-]{11})/,
  /youtu\.be\/([A-Za-z0-9_-]{11})/,
  /\/live\/([A-Za-z0-9_-]{11})/,
  /\/shorts\/([A-Za-z0-9_-]{11})/,
  /\/embed\/([A-Za-z0-9_-]{11})/,
  /\/(?:v|e)\/([A-Za-z0-9_-]{11})/,
];

const OFFLINE_STATUS = {
  LIVE_STREAM_OFFLINE: 'трансляция ещё не началась',
  LOGIN_REQUIRED: 'видео приватное или с ограничением по возрасту',
  UNPLAYABLE: 'видео недоступно (только для спонсоров?)',
  ERROR: 'видео недоступно',
};

function directVideoId(url) {
  for (const re of VIDEO_ID_RE) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

function intColor(n) {
  if (typeof n !== 'number') return null;
  return '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}

function thumbUrl(obj) {
  const t = obj && obj.thumbnails;
  if (!Array.isArray(t) || !t.length) return null;
  let u = t[t.length - 1].url;
  if (u && u.startsWith('//')) u = 'https:' + u;
  return u && /^https:/.test(u) ? u : null;
}

function runsToParts(runs) {
  const parts = [];
  const pushText = v => {
    if (!v) return;
    const last = parts[parts.length - 1];
    if (last && last.t === 'text') last.v += v;
    else parts.push({ t: 'text', v });
  };
  for (const run of runs || []) {
    if (run.text != null) { pushText(run.text); continue; }
    const e = run.emoji;
    if (!e) continue;
    if (e.isCustomEmoji) {
      const url = thumbUrl(e.image);
      if (url) parts.push({ t: 'emote', url, alt: (e.shortcuts && e.shortcuts[0]) || (e.searchTerms && e.searchTerms[0]) || 'emoji' });
      else pushText((e.shortcuts && e.shortcuts[0]) || '');
    } else {
      // standard unicode emoji: emojiId is the literal character
      pushText(e.emojiId || (e.shortcuts && e.shortcuts[0]) || '');
    }
  }
  return parts;
}

function runsToText(runs) {
  return (runs || []).map(r => r.text != null ? r.text : (r.emoji ? (r.emoji.emojiId || '') : '')).join('');
}

function simpleOrRuns(node) {
  if (!node) return '';
  if (node.simpleText != null) return node.simpleText;
  return runsToText(node.runs);
}

function authorFrom(r) {
  const author = {
    name: simpleOrRuns(r.authorName),
    color: null,
    roles: [],
    key: r.authorExternalChannelId || null,
    avatar: thumbUrl(r.authorPhoto),
  };
  for (const b of r.authorBadges || []) {
    const br = b.liveChatAuthorBadgeRenderer;
    if (!br) continue;
    const icon = br.icon && br.icon.iconType;
    if (icon === 'MODERATOR') author.roles.push('mod');
    else if (icon === 'OWNER') author.roles.push('owner');
    else if (icon === 'VERIFIED') author.roles.push('verified');
    else if (br.customThumbnail) {
      author.roles.push('member');
      author.badgeUrl = thumbUrl(br.customThumbnail);
    }
  }
  return author;
}

// First {continuation, timeoutMs?} among the wrappers of continuations[i].
function contData(conts) {
  for (const c of conts || []) {
    if (!c || typeof c !== 'object') continue;
    for (const v of Object.values(c)) {
      if (v && typeof v === 'object' && typeof v.continuation === 'string') {
        return { token: v.continuation, timeoutMs: typeof v.timeoutMs === 'number' ? v.timeoutMs : null };
      }
    }
  }
  return null;
}

// Extract the JSON object assigned after `marker` in an HTML page (balanced-brace scan).
function extractJson(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = html.indexOf('{', idx + marker.length);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(html.slice(start, i + 1)); } catch (e) { return null; }
        }
      }
    }
  }
  return null;
}

function get(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null) return null;
    cur = cur[k];
  }
  return cur == null ? null : cur;
}

class YouTubeSource {
  // handlers: { onMessage, onRemove, onRemoveAuthor, onClear, onStatus, onMeta }
  constructor(url, handlers) {
    this.url = url;
    this.h = handlers;
    this.stopped = false;
    this.timer = null;
    this.abort = null;
    this.videoId = null;
    this.apiKey = null;
    this.clientVersion = '2.20260708.00.00';
    this.continuation = null;
    this.errStreak = 0;
    this.seen = new Set();
    this.seenQueue = [];
  }

  start() {
    this.stopped = false;
    this._resolve();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.abort) this.abort.abort();
  }

  _later(fn, ms) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(fn, ms);
  }

  async _fetch(url, opts = {}) {
    this.abort = new AbortController();
    const t = setTimeout(() => this.abort.abort(), 20000);
    try {
      return await fetch(url, {
        ...opts,
        signal: this.abort.signal,
        headers: {
          'user-agent': UA,
          'accept-language': 'en-US,en;q=0.9',
          'cookie': COOKIE,
          ...(opts.headers || {}),
        },
      });
    } finally { clearTimeout(t); }
  }

  // --- step 1: url -> videoId ---
  async _resolve() {
    if (this.stopped) return;
    this.h.onStatus('connecting', 'ищу трансляцию…');
    try {
      let id = directVideoId(this.url);
      if (!id) {
        const u = new URL(/^https?:/i.test(this.url) ? this.url : 'https://' + this.url);
        let pathname = u.pathname.replace(/\/+$/, '').replace(/\/(streams|videos|featured|community|about)$/, '');
        if (!/\/live$/.test(pathname)) pathname += '/live';
        const page = await this._fetch(ORIGIN + pathname);
        const html = await page.text();
        const canon = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/);
        if (!canon) {
          this.h.onStatus('offline', 'канал сейчас не в эфире — проверяю раз в минуту');
          return this._later(() => this._resolve(), 60000);
        }
        id = canon[1];
      }
      this.videoId = id;
      this._initChat();
    } catch (e) {
      if (this.stopped) return;
      this.h.onStatus('error', 'нет доступа к YouTube: ' + e.message);
      this._later(() => this._resolve(), 30000);
    }
  }

  // --- step 2+3: watch page -> base token -> live_chat page -> view token + seed ---
  async _initChat() {
    if (this.stopped) return;
    try {
      const page = await this._fetch(`${ORIGIN}/watch?v=${this.videoId}`);
      const html = await page.text();

      const key = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
      if (key) this.apiKey = key[1];
      const cv = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION"\s*:\s*"([^"]+)"/) || html.match(/"clientVersion"\s*:\s*"([\d.]+)"/);
      if (cv) this.clientVersion = cv[1];

      if (/"isReplay"\s*:\s*true/.test(html)) {
        this.h.onStatus('offline', 'эта трансляция уже завершена');
        return this._later(() => this._resolve(), 60000);
      }

      // The only watch-page token get_live_chat accepts (post-Oct-2025):
      // conversationBar.liveChatRenderer.continuations[0].reloadContinuationData
      let base = null;
      const data = extractJson(html, 'ytInitialData');
      const bar = get(data, ['contents', 'twoColumnWatchNextResults', 'conversationBar']);
      base = get(bar, ['liveChatRenderer', 'continuations', 0, 'reloadContinuationData', 'continuation']);
      if (!base) {
        const rx = html.match(/"liveChatRenderer"\s*:\s*\{[\s\S]{0,4000}?"continuations"\s*:\s*\[\s*\{\s*"reloadContinuationData"\s*:\s*\{\s*"continuation"\s*:\s*"([^"]+)"/);
        if (rx) base = rx[1];
      }
      if (!base) {
        const unavailable = simpleOrRuns(get(bar, ['conversationBarRenderer', 'availabilityMessage', 'messageRenderer', 'text']));
        const status = html.match(/"playabilityStatus"\s*:\s*\{\s*"status"\s*:\s*"(\w+)"/);
        const why = unavailable || (status && OFFLINE_STATUS[status[1]]) || 'чат недоступен';
        this.h.onStatus('offline', why + ' — проверяю раз в минуту');
        return this._later(() => this._resolve(), 60000);
      }

      // live_chat page: working per-view tokens (0 = Top chat, 1 = Live chat) + first messages
      let token = base;
      let seedActions = [];
      try {
        const chatPage = await this._fetch(`${ORIGIN}/live_chat?continuation=${encodeURIComponent(base)}`);
        const chatHtml = await chatPage.text();
        const cdata = extractJson(chatHtml, 'ytInitialData');
        const lcc = get(cdata, ['continuationContents', 'liveChatContinuation'])
          || get(cdata, ['contents', 'liveChatRenderer']); // legacy shape, just in case
        if (lcc) {
          const items = get(lcc, ['header', 'liveChatHeaderRenderer', 'viewSelector', 'sortFilterSubMenuRenderer', 'subMenuItems']);
          const all = get(items, [1, 'continuation', 'reloadContinuationData', 'continuation']);
          if (all) token = all;
          else {
            const cd = contData(lcc.continuations);
            if (cd) token = cd.token;
          }
          seedActions = lcc.actions || [];
        }
      } catch (e) { /* seed page is best-effort; polling with the base token still works */ }

      this.continuation = token;
      this.errStreak = 0;
      this.h.onStatus('live', 'чат подключен');
      this._meta();
      this._handleActions(seedActions);
      this._later(() => this._poll(), 1000);
    } catch (e) {
      if (this.stopped) return;
      this.h.onStatus('error', 'ошибка инициализации чата: ' + e.message);
      this._later(() => this._resolve(), 30000);
    }
  }

  // Channel title via public oEmbed (nice-to-have, non-fatal).
  async _meta() {
    try {
      const r = await this._fetch(`${ORIGIN}/oembed?url=${encodeURIComponent(ORIGIN + '/watch?v=' + this.videoId)}&format=json`);
      if (r.ok) {
        const j = await r.json();
        if (j.author_name) this.h.onMeta({ channel: j.author_name });
      }
    } catch (e) { /* ignore */ }
  }

  // --- step 4: poll loop ---
  async _poll() {
    if (this.stopped) return;
    try {
      const qs = (this.apiKey ? `key=${encodeURIComponent(this.apiKey)}&` : '') + 'prettyPrint=false';
      const r = await this._fetch(`${ORIGIN}/youtubei/v1/live_chat/get_live_chat?${qs}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'origin': ORIGIN,
          'x-origin': ORIGIN,
          'x-youtube-client-name': '1',
          'x-youtube-client-version': this.clientVersion,
          'referer': `${ORIGIN}/live_chat?continuation=${encodeURIComponent(this.continuation).slice(0, 512)}`,
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: this.clientVersion,
              hl: 'en',
              gl: 'US',
              timeZone: 'UTC',
              utcOffsetMinutes: 0,
            },
          },
          continuation: this.continuation,
        }),
      });
      if (r.status === 400 || r.status === 404) {
        // stale/invalid continuation — re-init from the watch page
        this.h.onStatus('connecting', 'токен чата устарел, переподключаюсь…');
        return this._later(() => this._initChat(), 3000);
      }
      if (!r.ok) {
        const retryAfter = Number(r.headers.get('retry-after')) || 0;
        if (r.status === 429 || r.status === 403) {
          this.errStreak++;
          return this._later(() => this._poll(), Math.max(retryAfter * 1000, 15000));
        }
        throw new Error('HTTP ' + r.status);
      }
      const j = await r.json();
      const lcc = get(j, ['continuationContents', 'liveChatContinuation']);
      if (!lcc) {
        this.h.onStatus('offline', 'трансляция завершилась — жду новую');
        return this._later(() => this._resolve(), 60000);
      }
      const cd = contData(lcc.continuations);
      if (cd && cd.token) this.continuation = cd.token;
      this._handleActions(lcc.actions || []);
      this.errStreak = 0;
      const wait = Math.max(1000, Math.min(8000, (cd && cd.timeoutMs) || 5000));
      this._later(() => this._poll(), wait);
    } catch (e) {
      if (this.stopped) return;
      this.errStreak++;
      if (this.errStreak >= 5) {
        this.h.onStatus('error', 'потерял чат, переподключаюсь: ' + e.message);
        this.errStreak = 0;
        return this._later(() => this._initChat(), 5000);
      }
      this._later(() => this._poll(), Math.min(60000, 2000 * 2 ** this.errStreak) + Math.random() * 1000);
    }
  }

  _remember(id) {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.seenQueue.push(id);
    while (this.seenQueue.length > 3000) this.seen.delete(this.seenQueue.shift());
    return true;
  }

  _handleActions(actions) {
    for (const a of actions || []) {
      if (a.replayChatItemAction) { this._handleActions(a.replayChatItemAction.actions); continue; }
      if (a.addChatItemAction) { this._emit(a.addChatItemAction.item); continue; }
      if (a.replaceChatItemAction) { this._emit(a.replaceChatItemAction.replacementItem); continue; }
      if (a.markChatItemAsDeletedAction) { this.h.onRemove('yt:' + a.markChatItemAsDeletedAction.targetItemId); continue; }
      if (a.removeChatItemAction) { this.h.onRemove('yt:' + a.removeChatItemAction.targetItemId); continue; }
      if (a.markChatItemsByAuthorAsDeletedAction) {
        this.h.onRemoveAuthor(a.markChatItemsByAuthorAsDeletedAction.externalChannelId);
        continue;
      }
      // ticker/tooltip/poll/banner actions are ignored
    }
  }

  _emit(item) {
    const msg = this._parseItem(item);
    if (msg && this._remember(msg.id)) this.h.onMessage(msg);
  }

  _parseItem(item) {
    if (!item) return null;
    let r;
    if ((r = item.liveChatTextMessageRenderer)) {
      return {
        id: 'yt:' + r.id,
        kind: 'chat',
        author: authorFrom(r),
        parts: runsToParts(r.message && r.message.runs),
      };
    }
    if ((r = item.liveChatPaidMessageRenderer)) {
      return {
        id: 'yt:' + r.id,
        kind: 'super',
        author: authorFrom(r),
        parts: runsToParts(r.message && r.message.runs),
        amount: simpleOrRuns(r.purchaseAmountText),
        colors: { header: intColor(r.headerBackgroundColor), body: intColor(r.bodyBackgroundColor) },
      };
    }
    if ((r = item.liveChatPaidStickerRenderer)) {
      return {
        id: 'yt:' + r.id,
        kind: 'super',
        author: authorFrom(r),
        parts: [],
        amount: simpleOrRuns(r.purchaseAmountText),
        sticker: thumbUrl(r.sticker),
        colors: { header: intColor(r.moneyChipBackgroundColor), body: intColor(r.backgroundColor) },
      };
    }
    if ((r = item.liveChatMembershipItemRenderer)) {
      return {
        id: 'yt:' + r.id,
        kind: 'member',
        author: authorFrom(r),
        parts: runsToParts(r.message && r.message.runs),
        system: runsToText(get(r, ['headerPrimaryText', 'runs'])) || runsToText(get(r, ['headerSubtext', 'runs'])) || simpleOrRuns(r.headerSubtext),
      };
    }
    if ((r = item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer)) {
      const hr = get(r, ['header', 'liveChatSponsorshipsHeaderRenderer']);
      if (!hr) return null;
      return {
        id: 'yt:' + (r.id || Math.random().toString(36).slice(2)),
        kind: 'member',
        author: authorFrom({ authorName: hr.authorName, authorPhoto: hr.authorPhoto, authorBadges: hr.authorBadges, authorExternalChannelId: r.authorExternalChannelId }),
        parts: [],
        system: runsToText(get(hr, ['primaryText', 'runs'])) || simpleOrRuns(hr.primaryText),
      };
    }
    if ((r = item.liveChatSponsorshipsGiftRedemptionAnnouncementRenderer)) {
      return {
        id: 'yt:' + r.id,
        kind: 'member',
        author: authorFrom(r),
        parts: [],
        system: runsToText(get(r, ['message', 'runs'])),
      };
    }
    return null; // placeholders, engagement messages, mode changes etc.
  }
}

module.exports = { YouTubeSource };
