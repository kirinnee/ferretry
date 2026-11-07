/** The link-store Worker's deployment rules: its own Worker with no address, deployed only by a person. */
import { describe, expect, it } from 'bun:test';
import { LINK_WINDOW_MAX_KEYS } from '../../../worker/src/adapters/index.ts';
import { SlidingWindows } from '../../../worker/src/lib/index.ts';

const WORKER = new URL('../../../worker/', import.meta.url);
const REPO = new URL('../../../../../../', import.meta.url);

/** The hosted config is plain JSON; the self-hosted one is JSONC (line comments and trailing commas). */
async function config(name: string): Promise<Record<string, unknown>> {
  const text = await Bun.file(new URL(name, WORKER)).text();
  const stripped = text
    .split('\n')
    .filter(line => !/^\s*\/\//u.test(line))
    .join('\n')
    .replace(/,(\s*[}\]])/gu, '$1');
  return JSON.parse(stripped) as Record<string, unknown>;
}

describe('link-store Worker deployment', () => {
  it('R694 the hosted store is its own Worker with no address of its own, named for the relay binding', async () => {
    const hosted = await config('wrangler.link-store.hosted.json');
    // The relay's `LINK_STORE` service binding names this Worker; renaming it would unbind the store.
    expect(hosted['name']).toBe('ferretry-hosted-link-store');
    expect(hosted['workers_dev']).toBe(false);
    expect(hosted['routes']).toBeUndefined();
    expect(hosted['route']).toBeUndefined();
    expect(hosted['main']).toBe('src/adapters/link-store-worker.ts');
    expect(await Bun.file(new URL(hosted['main'] as string, WORKER)).exists()).toBe(true);
    const selfHosted = await config('wrangler.link-store.jsonc');
    expect(selfHosted['name']).toBe('ferretry-link-store');
    expect(selfHosted['main']).toBe('src/adapters/link-store-worker.ts');
  });

  it('R695 a deploy is refused in CI unless the unattended flag is set', () => {
    const script = new URL('scripts/local/link-store-deploy.sh', REPO).pathname;
    const env = { PATH: process.env['PATH'] ?? '', HOME: '/nonexistent', CI: 'true' };
    const refused = Bun.spawnSync(['bash', script], { env, stdin: 'ignore', cwd: new URL('.', REPO).pathname });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.toString()).toContain('refusing to deploy the link store from CI');
    const headless = Bun.spawnSync(['bash', script], {
      env: { PATH: env.PATH, HOME: env.HOME },
      stdin: 'ignore',
      cwd: new URL('.', REPO).pathname,
    });
    expect(headless.exitCode).toBe(1);
    expect(headless.stderr.toString()).toContain('without a terminal');
  });

  it('R704 a per-address window holds at most its key bound and keeps only the newest keys', () => {
    const windows = new SlidingWindows(LINK_WINDOW_MAX_KEYS);
    for (let address = 0; address < 5000; address += 1) windows.hit(`ip:${address}`, 1_000);
    expect(LINK_WINDOW_MAX_KEYS).toBe(4096);
    expect(windows.size()).toBe(LINK_WINDOW_MAX_KEYS);
    expect(windows.count('ip:0', 1_000)).toBe(0);
    expect(windows.count('ip:4999', 1_000)).toBe(1);
  });
});
