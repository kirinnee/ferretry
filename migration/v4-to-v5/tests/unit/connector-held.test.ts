/**
 * A held v4 config file must not take the connector with it. The accepted-config step records what v4 ENFORCED for every
 * config the converter writes; when ANY v4 file is held (an unconfirmed loosening), that record is rebuilt from the plain
 * dry pass over the CONFIG_STEPS. A connector step missing from that list leaves `connector.yaml` with no record, so the
 * kernel judges "enabled: true" against its defaults as a loosening and holds the owner's connector OFF.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { acceptedName } from '@ferretry/kernel/contract';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_STEPS, convert } from '../../src/convert.ts';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { connectorStep } from '../../src/steps/connector.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const put = async (path: string, text: string) => {
  await mkdir(join(f.from, path, '..'), { recursive: true });
  await writeFile(join(f.from, path), text, { mode: 0o600 });
};
const acceptedDir = () => join(f.to, 'state/kernel/accepted-config');
const records = async () => (await readdir(acceptedDir()).catch(() => [] as string[])).sort();

test('the connector step is one of the steps whose config the accepted record is rebuilt from', () => {
  expect(CONFIG_STEPS.has(connectorStep.id)).toBe(true);
});

test('an unrelated held v4 edit still records connector.yaml: the connector is not held off', async () => {
  await put('layout-version', '2\n');
  await put(
    'config/daemon.json',
    JSON.stringify({ connector: { enabled: true, publicUrl: 'https://ferretry.atomi.cloud' } }),
  );
  // warden.yaml: v4 enforces `enabled: false`; the file now says true (a loosening nobody confirmed), so it is HELD.
  await put('config/warden.yaml', 'enabled: true\n');
  await put(
    'state/config-accepted.json',
    JSON.stringify({ 'warden.yaml': { etag: sha256('enabled: false\n'), text: 'enabled: false\n' } }),
  );
  const result = await convert({
    from: f.from,
    to: f.to,
    dryRun: false,
    lock: { held: async () => false },
    now: () => new Date('2026-11-09T00:00:00Z'),
    host: { homeDirectory: f.root, env: {} },
    steps: [settingsStep, connectorStep, acceptedConfigStep],
  });
  expect(result.kind).toBe('done');
  expect(await records()).toContain(`${acceptedName('connector.yaml')}.json`);
  const record = JSON.parse(await readFile(join(acceptedDir(), `${acceptedName('connector.yaml')}.json`), 'utf8')) as {
    text: string;
  };
  expect(record.text).toContain('enabled: true');
});
