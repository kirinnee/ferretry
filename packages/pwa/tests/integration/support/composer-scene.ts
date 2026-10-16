/**
 * The real-browser composer scene, served: `tests/integration/fixtures/composer-editor-scene.tsx` and
 * the app's whole stylesheet, built by `scripts/build-composer-integration-fixture.ts` in a CHILD
 * process — a component-graph build inside the runner is what wedged the integration tier before —
 * and served from loopback so nothing in a journey can reach a daemon.
 *
 * Shared by every composer journey file, so the scene's build, page shell and server are one fact.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dir, '../../..');

const SCENE_CSS = `
  body { background: var(--fy-bg, var(--bg)); margin: 0; }
  .scene { box-sizing: border-box; margin: 0 auto; max-width: 760px; padding: 24px 16px; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; height: var(--app-h, 100dvh); left: 0; position: fixed; right: 0; top: var(--app-top, 0px); }
  .scene-transcript { color: var(--fy-fg); flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0 16px; }
  .scene-composer { padding: 6px 12px 8px; }
  .scene-entries { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; }
  .scene-entries .fy-transcript-shell { height: 120px; position: relative; }
`;

export interface ComposerSceneServer {
  /** The scene's origin, ready for `?<parameters>`. */
  readonly url: string;
  stop(): Promise<void>;
}

/** Builds the scene and serves it from loopback. */
export const serveComposerScene = async (): Promise<ComposerSceneServer> => {
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-composer-'));
  const child = Bun.spawn(
    [process.execPath, resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'), '--out', directory],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const deadline = setTimeout(() => child.kill('SIGKILL'), 150_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(deadline);
  if (code !== 0) throw new Error(`the composer scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><style>${SCENE_CSS}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/app.css') return new Response(css, { headers: { 'content-type': 'text/css' } });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  return {
    url: server.url.toString(),
    stop: async () => {
      server.stop(true);
      await rm(directory, { force: true, recursive: true });
    },
  };
};
