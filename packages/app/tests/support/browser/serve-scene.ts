/**
 * Serves ONE real-app scene over Vite's dev server, for a visual test that needs the app's REAL module graph (every shipped
 * plugin's app half, which loads its views with Vite's dynamic-import variables: `import(\`./views/${name}.tsx\`)` — a
 * bundle `build-scene.ts` makes through `Bun.build` leaves those as unresolved URLs). Run as a child process, never in the test
 * runner (the same reason `build-scene.ts` is one); it prints ONE JSON line, `{"origin":"http://127.0.0.1:<port>"}`, when it
 * listens, and serves until it is killed.
 *
 *   bun serve-scene.ts --entry <absolute path of the scene's module>
 *
 * Any path under `/d/`, `/settings` or `/pair`, and `/`, answers a page that loads the app's stylesheets and the entry, as the
 * app's own `app/index.html` does for those routes. The app's `vite.config.ts` is the config (its Tailwind, its text-scale
 * pass, its defines), so the page is styled and built exactly as the release is.
 *
 * `node:crypto` is served as a stub module: Vite's dev server refuses to evaluate a Node built-in in the browser (a production build
 * shims it silently), and one module the app reaches only names it.
 */
import { resolve } from 'node:path';
import { createServer } from 'vite';

const entryAt = Bun.argv.indexOf('--entry');
const entry = entryAt === -1 ? undefined : Bun.argv[entryAt + 1];
if (entry === undefined || !entry.startsWith('/')) throw new Error('❌ --entry <absolute path> is required');

const packageRoot = resolve(import.meta.dir, '../../..');
const workspace = resolve(packageRoot, '../..');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content"><meta name="color-scheme" content="light dark"><title>Ferretry</title></head><body><div id="root"></div><script type="module" src="/@fs${entry}"></script></body></html>`;
const PAGE = /^\/(?:d\/|settings|pair|$)/u;

// Tailwind resolves its `content` globs against the working directory: the app's, whoever started this child.
process.chdir(packageRoot);

const server = await createServer({
  configFile: resolve(packageRoot, 'vite.config.ts'),
  root: packageRoot,
  logLevel: 'error',
  server: { port: 0, host: '127.0.0.1', fs: { allow: [workspace] }, hmr: false },
  // The scene's entry is injected by the page middleware below, not an HTML file Vite scans, so the dependency scan never sees
  // the production JSX runtime that Durian's TSX source (served raw, `react-jsx`) imports. Left to be found at run time it is
  // served as the raw CommonJS file (`does not provide an export named 'jsx'`) and the chat view never mounts. Name it up front.
  optimizeDeps: { include: ['react/jsx-runtime'] },
  plugins: [
    {
      // `node:crypto` as a module that throws when used, not one Vite refuses to evaluate.
      name: 'node-crypto-stub',
      enforce: 'pre',
      resolveId: id => (id === 'node:crypto' ? '\0node-crypto-stub' : undefined),
      load: id =>
        id === '\0node-crypto-stub'
          ? "export const createHash = () => { throw new Error('node:crypto is not available in a browser scene'); }; export default {};"
          : undefined,
    },
    {
      name: 'scene-page',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (!PAGE.test(request.url ?? '')) return next();
          response.setHeader('content-type', 'text/html');
          response.end(html);
        });
      },
    },
  ],
});
await server.listen();
const address = server.httpServer?.address();
if (address === null || address === undefined || typeof address === 'string')
  throw new Error('❌ the scene server did not listen');
console.log(JSON.stringify({ origin: `http://127.0.0.1:${address.port}` }));
