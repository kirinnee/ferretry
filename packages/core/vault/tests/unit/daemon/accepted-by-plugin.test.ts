import { describe, expect, test } from 'bun:test';
import { defineConfig, type Log } from '@ferretry/kernel/contract';
import { config, state } from '@ferretry/kernel/host';
import type { Needer } from '@ferretry/kernel/manifest';
import { fixedClock } from '@ferretry/kernel/testing';
import { z } from 'zod';
import { allowedSecretNames, mayUseSecret } from '../../../daemon/lib/secrets/reach.ts';

/**
 * NN2 through the Vault: a credential record the owner confirmed for plugin A names `${secret:RECORD_KEY}`. A second
 * plugin that claims the same path does not inherit that confirmation, so the reference is not in effect for it and the
 * Vault does not let it spend the secret. Every case runs through the REAL config service over one shared file system
 * and reads the Vault's decision from {@link allowedSecretNames}, the one place a needer's allowed names are decided.
 */
const HOME = '/home/fy';
const KEY = 'RECORD_KEY';

const Records = defineConfig({
  file: 'tenant/records.yaml',
  schema: z.strictObject({ key: z.string().optional() }),
  axis: 'configure',
  loosens: () => [],
  credentialRecords: true,
});

const silent: Log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
};

const claimedBy = (fs: ReturnType<typeof state.createMemoryHostFs>, plugin: string) =>
  config.createConfigFiles({
    home: HOME,
    fs,
    clock: fixedClock(),
    log: silent,
    binary: 'fy',
    defs: [{ plugin, def: Records }],
  });

/** A needer with no secrets of its own in its manifest, whose own references come from the real service. */
const neederOf = (id: string, files: ReturnType<typeof claimedBy>): Needer => ({
  id,
  permissions: { secrets: [] },
  ownedSecretReferences: () => files.credentialRecordReferences(id),
});

describe('NN2 a credential record accepted for one plugin is not spendable by another that claims its path', () => {
  test('NN2 plugin B claiming the path of plugin A’s confirmed record gets no allowed secret, and A keeps its own', async () => {
    const fs = state.createMemoryHostFs();
    fs.seed(`${HOME}/config/tenant/records.yaml`, `key: \${secret:${KEY}}\n`);
    // The owner confirms what they wrote, for plugin A.
    const a = claimedBy(fs, 'plugin-a');
    await a.reload();
    const [pending] = a.held();
    if (pending === undefined) throw new Error('expected the record to be held for the owner');
    expect(await a.confirm(pending.id)).toBe(true);
    expect([...allowedSecretNames(neederOf('plugin-a', a))]).toEqual([KEY]);
    expect(mayUseSecret(neederOf('plugin-a', a), KEY)).toBe(true);

    // Plugin B claims the same path over the same file system: A's record is not accepted for B.
    const b = claimedBy(fs, 'plugin-b');
    await b.reload();
    const needer = neederOf('plugin-b', b);
    expect([...allowedSecretNames(needer)]).toEqual([]);
    expect(mayUseSecret(needer, KEY)).toBe(false);
    expect(b.held()).toHaveLength(1);

    // B being held did not erase A's record: A, reloaded, still spends the secret.
    const again = claimedBy(fs, 'plugin-a');
    await again.reload();
    expect([...allowedSecretNames(neederOf('plugin-a', again))]).toEqual([KEY]);
  });
});
