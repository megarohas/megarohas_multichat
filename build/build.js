'use strict';
// Сборка единых исполняемых файлов (Node SEA — Single Executable Application).
//
//   node build/build.js            -> только Windows
//   node build/build.js all        -> Windows + Linux + macOS (кросс-сборка)
//   node build/build.js linux mac  -> выборочно
//
// Как это работает: server.js со всеми lib/* склеивается esbuild-ом в один
// файл, из него и public/* генерируется SEA-блоб, блоб инжектится (postject)
// в официальный бинарник Node НУЖНОЙ платформы той же версии, что и Node,
// которым запущен этот скрипт. macOS-бинарники после инъекции подписываются
// ad-hoc (rcodesign) — без этого arm64-макось их не запустит вовсе.
// Результат кладётся в dist/. Нужен интернет (бинарники Node, rcodesign).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILD = __dirname;
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(BUILD, 'cache');
const VER = process.version; // блоб SEA совместим только с той же версией Node
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const APP = 'megarohas_multichat';

function log(s) { console.log('[build] ' + s); }

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(' ')} -> exit ${r.status}`);
}

async function download(url, dest) {
  if (fs.existsSync(dest)) { log('в кеше: ' + path.basename(dest)); return; }
  log('скачиваю ' + url);
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

function ensureDeps() {
  if (fs.existsSync(path.join(BUILD, 'node_modules', 'postject'))
    && fs.existsSync(path.join(BUILD, 'node_modules', 'rcedit'))) return;
  log('npm install (esbuild + postject)…');
  const nodeDir = path.dirname(process.execPath);
  const npm = path.join(nodeDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  // портативный Node может не быть в PATH, а postinstall-скриптам нужен `node`
  const env = { ...process.env, PATH: nodeDir + path.delimiter + (process.env.PATH || '') };
  run(npm, ['install', '--no-audit', '--no-fund'], { cwd: BUILD, shell: process.platform === 'win32', env });
}

function bundle() {
  log('esbuild: server.js -> build/bundle.js');
  run(process.execPath, [
    path.join(BUILD, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    'server.js', '--bundle', '--platform=node', '--log-level=warning',
    '--outfile=' + path.join(BUILD, 'bundle.js'),
  ], { cwd: ROOT });
}

function makeBlob() {
  const assets = {};
  for (const f of fs.readdirSync(path.join(ROOT, 'public'))) {
    assets['public/' + f] = 'public/' + f;
  }
  fs.writeFileSync(path.join(BUILD, 'sea-config.json'), JSON.stringify({
    main: 'build/bundle.js',
    output: 'build/sea-prep.blob',
    disableExperimentalSEAWarning: true,
    assets,
  }, null, 2));
  log('генерирую SEA-блоб…');
  run(process.execPath, ['--experimental-sea-config', 'build/sea-config.json'], { cwd: ROOT });
}

function inject(exePath, macho) {
  const args = [
    path.join(BUILD, 'node_modules', 'postject', 'dist', 'cli.js'),
    exePath, 'NODE_SEA_BLOB', path.join(BUILD, 'sea-prep.blob'),
    '--sentinel-fuse', FUSE,
  ];
  if (macho) args.push('--macho-segment-name', 'NODE_SEA');
  run(process.execPath, args);
}

// Официальный бинарник Node для целевой платформы (та же версия, что у нас).
async function nodeBinFor(platArch) {
  const name = `node-${VER}-${platArch}`;
  const bin = path.join(CACHE, name, 'bin', 'node');
  if (!fs.existsSync(bin)) {
    const tarball = path.join(CACHE, name + '.tar.gz');
    await download(`https://nodejs.org/dist/${VER}/${name}.tar.gz`, tarball);
    log('распаковываю ' + name);
    run('tar', ['-xzf', tarball, '-C', CACHE, `${name}/bin/node`]);
  }
  return bin;
}

// rcodesign (проект apple-platform-rs) умеет ad-hoc подписывать Mach-O
// с любой ОС — качаем готовый exe с GitHub releases.
async function getRcodesign() {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const exe = path.join(CACHE, 'rcodesign' + suffix);
  if (fs.existsSync(exe)) return exe;
  const triple = process.platform === 'win32' ? 'x86_64-pc-windows-msvc'
    : process.platform === 'darwin' ? 'macos-universal'
    : 'x86_64-unknown-linux-musl';
  const ext = process.platform === 'win32' ? '.zip' : '.tar.gz';
  for (const v of ['0.29.0', '0.28.0', '0.27.0']) {
    const dirName = `apple-codesign-${v}-${triple}`;
    const archive = path.join(CACHE, dirName + ext);
    try {
      await download(`https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${v}/${dirName}${ext}`, archive);
      run('tar', ['-xf', archive, '-C', CACHE]);
      const inner = path.join(CACHE, dirName, 'rcodesign' + suffix);
      if (fs.existsSync(inner)) { fs.copyFileSync(inner, exe); return exe; }
      log(`rcodesign ${v}: распаковалось, но ${inner} не найден`);
    } catch (e) { log(`rcodesign ${v}: ${e.message}`); }
  }
  return null;
}

async function buildWin() {
  const out = path.join(DIST, APP + '-win-x64.exe');
  fs.copyFileSync(process.execPath, out);
  // иконка — ДО инъекции блоба, чтобы не трогать PE после postject
  const ico = path.join(ROOT, 'assets', 'icon.ico');
  if (process.platform === 'win32' && fs.existsSync(ico)) {
    log('ставлю иконку (rcedit)…');
    const rcedit = require(path.join(BUILD, 'node_modules', 'rcedit'));
    await rcedit(out, { icon: ico });
  }
  inject(out, false);
  log('готово: ' + out);
}

async function buildLinux() {
  const src = await nodeBinFor('linux-x64');
  const out = path.join(DIST, APP + '-linux-x64');
  fs.copyFileSync(src, out);
  inject(out, false);
  log('готово: ' + out + '  (после скачивания: chmod +x)');
}

async function buildMac() {
  const rc = await getRcodesign();
  if (!rc) log('ВНИМАНИЕ: rcodesign не добыт — mac-бинарники останутся с битой подписью (arm64 их не запустит)');
  for (const arch of ['x64', 'arm64']) {
    const src = await nodeBinFor('darwin-' + arch);
    const out = path.join(DIST, `${APP}-macos-${arch}`);
    fs.copyFileSync(src, out);
    inject(out, true);
    if (rc) {
      log(`подписываю ad-hoc: macos-${arch}`);
      run(rc, ['sign', out]);
    }
    log('готово: ' + out);
  }
}

(async () => {
  const want = process.argv.slice(2).map(s => s.toLowerCase());
  const all = want.includes('all');
  const targets = {
    win: all || want.length === 0 || want.includes('win'),
    linux: all || want.includes('linux'),
    mac: all || want.includes('mac'),
  };
  fs.mkdirSync(DIST, { recursive: true });
  fs.mkdirSync(CACHE, { recursive: true });
  ensureDeps();
  bundle();
  makeBlob();
  if (targets.win) await buildWin();
  if (targets.linux) await buildLinux();
  if (targets.mac) await buildMac();
  log('сборка завершена.');
})().catch(e => { console.error('[build] ОШИБКА:', e.message); process.exit(1); });
