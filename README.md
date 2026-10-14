# megarohas_multichat

**English** | [Русский](README.ru.md)

A local aggregator that merges **Twitch + YouTube** chats into one good-looking OBS overlay.
No API keys, no OAuth, no third-party services, **zero dependencies** — a single
Node.js process running on your own machine.

- Paste your stream links — messages from both platforms show up in a single
  chat in arrival order, in real time.
- The overlay is a plain page on `localhost` that OBS displays via a
  Browser Source (with a transparent background).
- Twitch emotes (including BTTV / FFZ / 7TV), YouTube custom emoji,
  Super Chat / Super Sticker, memberships, subs and raids, role badges.
- Moderation is respected: messages deleted by moderators and bans remove
  the messages from the overlay too.
- Messages appear strictly one at a time with a smooth animation (60 fps),
  and the top one is never cut off — if it doesn't fit, it gracefully scrolls away.

## Running

The easiest way is a **prebuilt binary** from the
[Releases](https://github.com/megarohas/megarohas_multichat/releases) page:
a single executable, nothing to install. `config.json`, the
`fonts` folder and `error.log` will appear next to it.

- Windows: `megarohas_multichat-win-x64.exe` — just run it.
- Linux: `chmod +x megarohas_multichat-linux-x64 && ./megarohas_multichat-linux-x64`
- macOS: remove the quarantine flag and run it (the binary is ad-hoc signed, so on
  first launch use right-click → "Open", or `xattr -d com.apple.quarantine <file>`).
  The macOS/Linux builds are cross-compiled and less battle-tested than the Windows one — if anything's off, open an issue.

Running from source requires Node.js 18+, and there are two ways to go:

1. **Portable** (nothing gets installed system-wide): download the zip from
   [nodejs.org](https://nodejs.org/en/download) ("Standalone / Binary", Windows x64)
   and unpack it so that you end up with `runtime\node\node.exe` next to `server.js`.
2. **System-wide**: just install Node.js.

Then, on Windows:

```bat
start.cmd
```

Linux / macOS:

```bash
./start.sh
```

(both scripts pick up the portable Node from `runtime/node` if it's there —
`runtime\node\node.exe` on Windows, `runtime/node/bin/node` on Linux/macOS —
and fall back to the system `node` otherwise).

- Control panel: **http://127.0.0.1:3131/**
- OBS overlay: **http://127.0.0.1:3131/overlay**

If you'd rather have the panel in its own app window than in a browser tab, run
`start-window.cmd` / `./start-window.sh` (it uses the `--app` mode of an
installed Edge/Chrome/Chromium).

### Network and port

- By default the server is reachable from **every device on your local network** —
  addresses like `http://192.168.x.x:3131/…` are printed to the console and shown in
  the panel (handy for OBS on another PC or for checking from your phone). On first
  launch Windows will ask for firewall permission — allow it for private networks.
  If you only need it on this PC, set `"host": "127.0.0.1"` in `config.json`.
- If the port is taken, the server picks the next free one and prints the
  actual address.

## Usage

1. Open the panel and paste your links:
   - Twitch: `twitch.tv/channel` (popout chat and mobile links work too)
   - YouTube: `youtube.com/watch?v=…`, `youtube.com/live/…`, `youtu.be/…`
     or just `youtube.com/@channel/live` — in that case you can add the link
     **before the stream starts**: the tool checks the channel once a minute and
     hooks in automatically when the stream goes live.
2. In OBS, add a "Browser" source with the overlay address (size ~450×700).
3. Use the «Тест-сообщения» ("Test messages") button in the panel to tune the look
   without being live.

Links are saved to `config.json` and restored on restart.

## Overlay parameters

Append them to the overlay URL, joined with `&`, for example
`http://127.0.0.1:3131/overlay?size=20&dir=top&fade=30`:

| Parameter | What it does |
|---|---|
| `size=22` | font size, px |
| `font=Name` | font: a system font by name, or a file from the `fonts` folder |
| `dir=top` | chat grows top-down (default is bottom-up) |
| `platform=0` | hide the platform icons (Twitch/YouTube) on messages |
| `badges=0` | hide role badges (moderator, VIP, sub, member, etc.) |
| `fade=20` | hide a message after N seconds |
| `ts=1` | show timestamps |
| `origcolors=1` | native Twitch nickname colors instead of the pastel palette |
| `limit=40` | cap on messages in the DOM (a safety net, default 60) |

**Custom fonts**: drop a `.ttf` / `.otf` / `.woff` / `.woff2` into the `fonts` folder;
the family name is the file name without the extension: `fonts\Rubik.ttf` → `?font=Rubik`.

**The look** is fully customizable in `public/overlay.css` — the variables are at the top
of the file (bubble background, corner radius, padding, animation durations, etc.).

## How it works

- **Twitch** — anonymous chat reading through the official IRC gateway
  (`irc.chat.twitch.tv`, login `justinfan…`). This is the standard way to read chat,
  no tokens needed. BTTV/FFZ/7TV emotes are fetched from their public APIs.
- **YouTube** — the same internal API (InnerTube `get_live_chat`) that the chat web
  page itself uses; that's how chat-downloader, yt-dlp and the like work.
  It's unofficial: if YouTube changes its internals, `lib/youtube.js` will need
  an update (the current schema is documented in the comments there).
- The server serves the panel and the overlay and pushes messages over SSE. Everything
  is local; the only outbound requests go to Twitch/YouTube themselves.

## Building the binaries

```bash
node build/build.js all
```

`server.js` is bundled into a single file with esbuild; that file plus `public/*` are
turned into a Node SEA (Single Executable Application) blob, which is injected into
the official Node binaries — Windows, Linux and macOS are all built from one
machine (macOS gets an ad-hoc signature via rcodesign, and the Windows exe gets the
icon embedded). The output goes to `dist/`. Requires an internet connection; the build
tools are installed into `build/node_modules` and don't affect the finished app.

The app icon is `assets/icon.ico` (+ `public/favicon.svg` for the pages):
to use your own, just replace the files; `build/make-icon.js` regenerates
the default one.

## Limitations

- Only public chats are read. YouTube members-only chat requires
  authentication and isn't supported.
- YouTube latency is a couple of seconds (polling); Twitch is near zero.
- `config.json`: `host`/`port` can be changed (e.g. to `0.0.0.0` if OBS
  is on another machine).
