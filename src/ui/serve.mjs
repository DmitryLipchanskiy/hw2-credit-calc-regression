/**
 * Static server for the calculator page. Started by Playwright (webServer) and usable
 * by hand: `node src/ui/serve.mjs`.
 *
 * Why it exists at all: the page loads app.js as an ES module, and a browser refuses
 * ES-module imports over file:// (opaque origin, CORS). Opened from disk the page stays
 * blank with nothing in the console to point at the real cause. An http origin removes
 * the whole class of problem.
 *
 * Cross-platform (CLAUDE.md rule 3): pure node, no shell, path.join everywhere,
 * no bare globals — process and URL are imported so eslint's flat config needs no
 * per-directory globals entry.
 */

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import process, { stdout } from 'node:process';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PORT = Number(process.env['PORT'] ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Compile the UI before serving it.
 *
 * The alternative is an npm script, and package.json is not this branch's to edit.
 * Doing it here also removes an ordering trap: a stale dist/ would make the suite fail
 * against yesterday's app.js and look like a UI bug. tsc is invoked as a JS file through
 * the current node binary rather than through `npx`, which is a .cmd shim on Windows.
 */
function build() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const project = path.join(ROOT, 'src', 'ui', 'tsconfig.ui.json');
  const built = spawnSync(process.execPath, [tsc, '-p', project], { encoding: 'utf8' });
  if (built.status !== 0) {
    stdout.write(`serve.mjs: UI build failed\n${built.stdout ?? ''}${built.stderr ?? ''}`);
    process.exit(1);
  }
}

const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();

/**
 * Path traversal is impossible by construction: '..' segments are dropped, not resolved.
 *
 * Returns either a file to send or a URL to redirect to.
 *
 * The redirect is the whole point of this function. tsc emits `import './schedule'` and
 * `import '../core'` verbatim — it never appends an extension, and src/core is not this
 * branch's to rewrite. Serving /dist/web/core straight from core/index.js "works" for
 * that one request and then breaks the next: a module's relative imports resolve against
 * the URL it was REQUESTED at, so './schedule' would become /dist/web/schedule and 404.
 * Redirecting to the canonical URL first makes the browser's base URL the real file.
 */
function resolveTarget(pathname) {
  if (pathname === '/' || pathname === '') {
    return { file: path.join(ROOT, 'src', 'ui', 'index.html') };
  }
  const segments = decodeURIComponent(pathname)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  const candidate = path.join(ROOT, ...segments);
  const clean = `/${segments.join('/')}`;

  if (isFile(candidate)) return { file: candidate };
  if (isFile(`${candidate}.js`)) return { redirect: `${clean}.js` };
  if (isFile(path.join(candidate, 'index.js'))) return { redirect: `${clean}/index.js` };
  return null;
}

build();

createServer((req, res) => {
  const target = resolveTarget(new URL(req.url ?? '/', `http://localhost:${PORT}`).pathname);
  if (target === null) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  if (target.redirect !== undefined) {
    res.writeHead(302, { Location: target.redirect, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  const type = MIME[path.extname(target.file)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(target.file));
}).listen(PORT, '127.0.0.1', () => {
  stdout.write(`serve.mjs: http://127.0.0.1:${PORT}/\n`);
});
