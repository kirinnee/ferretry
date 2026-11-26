/**
 * A DAMAGED v4 `state/config-accepted.json` must not take the connector off. v4 loads the connector switch from
 * `config/daemon.json` on its own, so the connector was ON in v4 whatever that record says; what v4 enforced for the
 * OTHER config files is unknown (nothing is recorded for them), but `connector.yaml` is carried independently.
 * Converter output is seeded into a REAL 5.0 `fyd` on a temp home; the tree is synthetic and the address a fake
 * loopback origin on a test port (7483; test daemons own 7480-7499).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { convert } from '../../src/convert.ts';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { connectorStep } from '../../src/steps/connector.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { fixture } from './ferret-fixture.ts';

const repo = join(import.meta.dir, '../../../..');
const { bootRealDaemon } = await import(repo + '/packages/plugins/connector/tests/support/daemon.ts');

const PORT = 7483;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;

type RealDaemon = Awaited<ReturnType<typeof bootRealDaemon>>;
let daemon: RealDaemon;
let f: Awaited<ReturnType<typeof fixture>>;
let report: string;

async function filesOf(root: string, folder: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else out.push([relative(root, child), await readFile(child, 'utf8')]);
    }
  };
  await walk(join(root, folder));
  return out;
}

beforeAll(async () => {
  f = await fixture();
  const put = async (path: string, text: string) => {
    await mkdir(join(f.from, path, '..'), { recursive: true });
    await writeFile(join(f.from, path), text, { mode: 0o600 });
  };
  await put('layout-version', '2\n');
  await put(
    'config/daemon.json',
    JSON.stringify({ connector: { enabled: true, publicUrl: ORIGIN, port: PORT, extraRedirectUris: [] } }),
  );
  // The ONLY thing wrong with this tree: the acceptance record is damaged (what v4 enforced elsewhere is unknown).
  await put('state/config-accepted.json', '{ "warden.yaml": ');
  const converted = await convert({
    from: f.from,
    to: f.to,
    dryRun: false,
    lock: { held: async () => false },
    now: () => new Date(),
    host: { homeDirectory: f.root, env: {} },
    steps: [settingsStep, connectorStep, acceptedConfigStep],
  });
  expect(converted.kind).toBe('done');
  report = JSON.stringify(converted);
  const seed = Object.fromEntries([...(await filesOf(f.to, 'config')), ...(await filesOf(f.to, 'state'))]);
  daemon = await bootRealDaemon(seed);
}, 240_000);
afterAll(async () => {
  await daemon?.dispose();
  await f?.clean();
});

test('with a damaged acceptance record the converted connector is still ON IN EFFECT at its own address', async () => {
  const status = await daemon.fy(['connector', '--json']);
  expect(status.code, status.err).toBe(0);
  expect(status.json).toMatchObject({
    enabled: true,
    switchedOn: true,
    publicUrlSource: 'configured',
    mcpUrl: `${ORIGIN}/mcp`,
  });
});

test('the damaged record is still named in the report (nothing else is claimed as enforced)', () => {
  expect(report).toContain('config-accepted.json');
});
