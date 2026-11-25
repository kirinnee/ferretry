import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { definePort } from '../../../contract/define.ts';
import { bootHost, type RunningHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';

/**
 * `permissions.revealMinted` is MCP's alone, and the BOOT enforces it, wherever the plugin stands to the Vault: a
 * plugin that NEEDS the Vault, one that only USES it (optional), and one that names no Vault at all are all refused,
 * so the check cannot depend on the Vault ever building a port for the plugin. A REAL `bootHost`, not the in-memory host.
 */
const homes: string[] = [];
const running: RunningHost[] = [];
afterEach(async () => {
  for (const host of running.splice(0)) await host.stop();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const Keeper = definePort<{ readonly ok: true }>('keeper');
const BASE = { title: 'Plugin', version: '5.0.0', api: 5, core: false, kinds: [] } as const;

const tenant = (id: string, shape: { readonly needs?: true; readonly uses?: true }, reveal: boolean) =>
  implementDaemon(
    definePlugin({
      ...BASE,
      id,
      title: id,
      ...(shape.needs === true ? { needs: { keeper: Keeper } } : {}),
      ...(shape.uses === true ? { uses: { keeper: Keeper } } : {}),
      ...(reveal ? { permissions: { revealMinted: true as const } } : {}),
    }),
    { build: () => ({}) },
  );

async function boot(implementations: ReturnType<typeof tenant>[]): Promise<RunningHost> {
  const parent = await mkdtemp(`${tmpdir()}/fy-reveal-`);
  homes.push(parent);
  const home = `${parent}/home`;
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    implementations: [
      implementDaemon(
        definePlugin({ ...BASE, id: 'vault', title: 'Vault', core: true, provides: { keeper: Keeper } }),
        { build: () => ({ provides: { keeper: { ok: true as const } } }) },
      ),
      ...implementations,
    ],
    adapters: realAdapters(home, () => {}, { binary: 'fy' }),
  });
  if (outcome.kind !== 'running') throw new Error('the host refused to boot');
  running.push(outcome.host);
  return outcome.host;
}

test('a plugin other than MCP that declares revealMinted is refused, with the Vault required, optional or absent', async () => {
  const host = await boot([
    tenant('required', { needs: true }, true),
    tenant('optional', { uses: true }, true),
    tenant('absent', {}, true),
  ]);

  for (const id of ['required', 'optional', 'absent']) {
    expect(host.plugins.get(id)?.status).toBe('failed');
    expect(host.plugins.get(id)?.failure).toMatch(/revealMinted/);
  }
});

test('MCP declaring revealMinted boots, and so does a plugin that does not declare it', async () => {
  const host = await boot([tenant('mcp', { needs: true }, true), tenant('plain', { uses: true }, false)]);

  expect(host.plugins.get('mcp')?.status).toBe('serving');
  expect(host.plugins.get('plain')?.status).toBe('serving');
});
