/**
 * S12 S62: the secrets a provider may treat as a needer's OWN are the `${secret:NAME}` references in effect in the
 * config defs its manifest marks `credentialRecords` and in nothing else. Every case runs through a REAL boot: the real
 * config service reads real files, and the real boot wires `credentialRecordReferences` into the `Needer` it hands a
 * per-needer factory. Deleting the credential-record filter in the service, or reading every reference in the boot's
 * wiring, makes the second test fail.
 */
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { defineConfig, definePort } from '../../../contract/index.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { bootHost, type HostOptions, type RunningHost } from '../../../host/host.ts';
import { createNodeHostFs } from '../../../host/state/index.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon, type Needer, perNeeder } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { silentLog } from './fixtures.ts';

const OwnedPort = definePort<{ readonly for: string }>('owned-references');

const Shape = z.strictObject({ key: z.string().optional(), extra: z.string().optional() });
const Records = defineConfig({
  file: 'tenant/records.yaml',
  schema: Shape,
  axis: 'configure',
  loosens: () => [],
  credentialRecords: true,
});
const Notes = defineConfig({ file: 'tenant/notes.yaml', schema: Shape, axis: 'configure', loosens: () => [] });

const providerPlugin = definePlugin({
  id: 'owners',
  title: 'Owners',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  provides: { owned: OwnedPort },
});
const tenantPlugin = definePlugin({
  id: 'tenant',
  title: 'Tenant',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  needs: { owned: OwnedPort },
  data: { config: [Records, Notes] },
});

test('S12 S62 a real boot counts a reference in a credential record, not one in an unmarked file or a held plugin write', async () => {
  const root = await mkdtemp(`${tmpdir()}/credential-records-`);
  const home = `${root}/home`;
  let running: RunningHost | undefined;
  try {
    await mkdir(`${home}/config/tenant`, { recursive: true });
    // A home that already holds files is used only when it says it is a Ferretry 5 home.
    await writeFile(
      `${home}/home.json`,
      JSON.stringify({ format: 1, createdBy: 'fyd 5.0.0', createdAt: '2026-11-06T09:00:00Z' }),
    );
    // The owner wrote a reference into the marked def AND one into the unmarked def of the same plugin.
    await writeFile(`${home}/config/tenant/records.yaml`, 'key: ${secret:RECORD_KEY}\n');
    await writeFile(`${home}/config/tenant/notes.yaml`, 'key: ${secret:NOTE_KEY}\n');
    // The owner CONFIRMS what they wrote (a file with a secret reference that nobody accepted is held), through the real
    // config service over the same home; the boot below then finds both files in effect.
    const seed = createConfigFiles({
      home,
      defs: [
        { plugin: 'tenant', def: Records },
        { plugin: 'tenant', def: Notes },
      ],
      fs: createNodeHostFs(),
      clock: fixedClock(),
      log: silentLog,
      binary: 'fy',
    });
    await seed.reload();
    expect(seed.held()).toHaveLength(2);
    for (const edit of seed.held()) expect(await seed.confirm(edit.id)).toBe(true);
    let who: Needer | undefined;
    let config: { write(...args: never[]): Promise<{ readonly kind: string }> } | undefined;
    const adapters: HostOptions['adapters'] = {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    };
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      adapters,
      implementations: [
        implementDaemon(providerPlugin, {
          build: () => ({
            provides: {
              owned: perNeeder((needer: Needer) => {
                who = needer;
                return { for: needer.id };
              }),
            },
          }),
        }),
        implementDaemon(tenantPlugin, {
          build: ({ kernel }) => {
            config = kernel.config as never;
            return {};
          },
        }),
      ],
    });
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    running = outcome.host;
    if (who === undefined || config === undefined) throw new Error('the tenant was not built');
    // 1. a reference in a credentialRecords def counts; 2. one in an unmarked def of the same plugin does not.
    expect([...who.ownedSecretReferences()]).toEqual(['RECORD_KEY']);
    // 3. a reference the plugin itself writes is held for the owner, so it is not in effect and does not count.
    const written = await (config.write as (...args: unknown[]) => Promise<{ readonly kind: string }>)(
      Records,
      undefined,
      { patch: { key: '${secret:RECORD_KEY}', extra: '${secret:HELD_KEY}' } },
    );
    expect(written.kind).toBe('held');
    expect([...who.ownedSecretReferences()]).toEqual(['RECORD_KEY']);
  } finally {
    await running?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
