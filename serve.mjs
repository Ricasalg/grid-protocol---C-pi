/* ============================================================================
   serve.mjs — the launcher.

   The game is static files. This is a static file server with no dependencies,
   so double-clicking it does everything: build, serve, open the browser.

   Why a server at all, when the files could just be opened from disk: browsers
   refuse ES modules over `file://` (CORS), and Chrome treats every local file as
   an opaque origin, which makes the self-hosted .woff2 fonts in src/assets
   fail to load. A real http:// origin is what makes both work. Nothing about
   the game changes — only how the files reach the browser.

   This server only ever reads from dist/. It binds to 127.0.0.1, so nothing on
   the network can reach it. It writes nothing except the build it triggers.

   Usage:  node serve.mjs [--port 5177] [--no-build] [--no-open]
   ========================================================================== */

import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');

/* --- arguments --- */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

let PORT = Number(opt('--port', process.env.GRID_PORT || 5177));
const BUILD = !flag('--no-build');
const OPEN = !flag('--no-open');

/* --- output helpers ---
   Plain lines, no colour: this runs in a console the player may be looking at
   directly, and colour codes in a minimized window are just noise. */

const say = (msg) => console.log(msg);
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

/* ---------------------------------------------------------------------------
   Build
   ------------------------------------------------------------------------- */

function build() {
  say('  building...');

  // Typecheck is deliberately skipped here. It is the slow half of `npm run
  // build` and it has already run as part of any change; a launcher that takes
  // ten seconds to open a window gets skipped by the player, and a launcher
  // nobody opens verifies nothing either.
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: false,
  });

  if (r.status !== 0) fail('  build failed — nothing changed. See the errors above.');
  say('  build ok');
}

/* ---------------------------------------------------------------------------
   Static serving
   ------------------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/**
 * Resolve a URL path to a file inside dist/, or null if it tries to escape.
 * normalize() collapses `..` before the prefix test, so a request for
 * `/../../Windows/System32/ini` resolves outside DIST and is refused. This
 * server is loopback-only, but a path that can read outside its own directory
 * is a bug waiting for a browser bug.
 */
function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const full = join(DIST, rel);

  if (full !== DIST && !full.startsWith(DIST + sep)) return null;
  return full;
}

async function serveFile(res, filePath) {
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      // The whole point is to edit the game and see it. A cached bundle would
      // hide the change behind a stale copy.
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

const server = createServer(async (req, res) => {
  let filePath = resolvePath(req.url || '/');
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }

  // A directory (or the root) resolves to its index.html.
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // Unknown path with no extension: let the single-page app route it.
    if (!extname(filePath)) filePath = join(DIST, 'index.html');
  }

  await serveFile(res, filePath);
});

/* ---------------------------------------------------------------------------
   Start
   ------------------------------------------------------------------------- */

/** Listen, moving to the next port if something already holds this one. */
function listen(attempt = 0) {
  if (attempt > 20) fail('  could not find a free port');

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      PORT++;
      listen(attempt + 1);
    } else {
      fail(`  server error: ${err.message}`);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;

    say('');
    say('  GRID PROTOCOL');
    say(`  ${url}`);
    say('');
    say('  Leave this window open while you play.');
    say('  Close it, or press Ctrl+C, to shut down.');
    say('');

    if (OPEN) openBrowser(url);
  });
}

function openBrowser(url) {
  // `start` is a cmd builtin, and the empty "" is the window title that would
  // otherwise swallow the URL. cmd's exit code is not the browser's, so it is
  // deliberately not checked.
  if (process.platform !== 'win32') {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }

  spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
}

/* --- go --- */

if (BUILD) build();

if (!existsSync(join(DIST, 'index.html'))) {
  fail('  dist/index.html not found — run the build first, or drop --no-build.');
}

listen();

/* Ctrl+C in the console should actually stop the process, or the player ends
   up with a server they cannot shut down from the window they were told to
   close. */
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
  process.exit(0);
});