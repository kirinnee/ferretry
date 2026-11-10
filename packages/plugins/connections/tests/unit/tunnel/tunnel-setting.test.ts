import { expect, it } from 'bun:test';
import type { ConfigFileDef, ConfigPort, ConfigWriteJudgement, ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { owner, standInAdmission, testHost } from '@ferretry/kernel/testing';
import manifest from '../../../manifest.ts';
import { writeTunnelSetting } from '../../../daemon/tunnel-setting.ts';
import { guarantee } from '../../support/guarantee.ts';

/**
 * BG-012 m-3: a refused write of the tunnel setting says the kernel's own sentence (a link, a file that is not UTF-8),
 * not only "could not be written to its document", which names no cause.
 */
const UNREADABLE =
  'connections.yaml cannot be read (a link, not a regular file, or larger than a config file may be), so nothing was written over it';
const FIX = 'replace the file with an ordinary one, then make the change again';

const over = (outcome: ConfigWriteOutcome): Pick<ConfigPort, 'writeAsOwner'> => ({ writeAsOwner: async () => outcome });
const def = manifest.data.config[0]!;

it('BG-012 m-3 a refused tunnel setting write names the kernel’s sentence and its fix', async () => {
  const config = over({
    kind: 'refused',
    reason: 'yaml',
    issues: [{ path: 'connections.yaml', message: UNREADABLE, fix: FIX }],
  });
  await expect(writeTunnelSetting(config, def, true)).rejects.toThrow(
    `the tunnel setting could not be written to its document: ${UNREADABLE}: ${FIX}`,
  );
});

it('BG-012 m-3 a refusal whose fix is the empty string ends in the kernel’s sentence, with no bare colon', async () => {
  const config = over({
    kind: 'refused',
    reason: 'yaml',
    issues: [{ path: 'connections.yaml', message: UNREADABLE, fix: '' }],
  });
  const error = await writeTunnelSetting(config, def, true).then(
    () => undefined,
    (thrown: unknown) => thrown as Error,
  );
  expect(error?.message).toBe(`the tunnel setting could not be written to its document: ${UNREADABLE}`);
});

guarantee(
  ['R656'],
  'should keep the tunnel setting as ONE object that names no address, so a machine has at most one tunnel',
  async () => {
    // Arrange
    const patches: unknown[] = [];
    const config: Pick<ConfigPort, 'writeAsOwner'> = {
      writeAsOwner: async (_def, _etag, write) => {
        patches.push((write as { patch: unknown }).patch);
        return { kind: 'written', etag: 'e', loosened: [] };
      },
    };

    // Act
    await writeTunnelSetting(config, def, true);
    await writeTunnelSetting(config, def, false);

    // Assert — each write is the one `tunnel` object holding only `enabled`: no list, no hostname, no second tunnel.
    expect(patches).toEqual([{ tunnel: { enabled: true } }, { tunnel: { enabled: false } }]);
    // And the machine keeps ONE tunnel record: a single declared state document, not one per tunnel.
    expect(manifest.data.state.filter(state => state.name === 'tunnel')).toHaveLength(1);
  },
);

it('BG-012 m-3 a refusal with nothing to say keeps the plain sentence, and a held write says it waits for the owner', async () => {
  await expect(writeTunnelSetting(over({ kind: 'conflict' }), def, true)).rejects.toThrow(
    'the tunnel setting could not be written to its document',
  );
  await expect(
    writeTunnelSetting(over({ kind: 'held', etag: 'e', id: 'i', sentences: ['x'] }), def, true),
  ).rejects.toThrow('waits for the owner to confirm');
  await expect(
    writeTunnelSetting(over({ kind: 'written', etag: 'e', loosened: [] }), def, false),
  ).resolves.toBeUndefined();
});

/**
 * Held-edit follow-up row 63 (M13): over the host's real config port (its held-edit rules, a judge that holds a
 * loosening). Another caller's edit of `connections.yaml` is held (the direct listener bound to every address); the
 * owner then switches the tunnel on. The switch must be in effect and the held edit must still be held and NOT in
 * effect, and it must be made through `writeAsOwner` (the kernel's plain `write` of a patch is made to both versions
 * too, so the outcome alone cannot tell the two calls apart: the second case pins which call was made).
 */
async function heldWorld() {
  const verdict = { now: 'hold' as 'apply' | 'hold' };
  let config: ConfigPort | undefined;
  const probe = implementDaemon(
    definePlugin({
      id: 'connections',
      title: 'Connections',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      data: { config: [def] },
    }),
    {
      build: ctx => {
        config = ctx.kernel.config;
        return {};
      },
    },
  );
  const host = await testHost({
    plugins: [probe],
    gate: {
      ...standInAdmission(() => owner()),
      judgeConfigWrite: (_input: ConfigWriteJudgement) => verdict.now,
    },
    config: { 'connections.yaml': { direct: { host: '127.0.0.1' }, tunnel: { enabled: false } } },
  });
  if (config === undefined) throw new Error('the probe was not built');
  const widened = await config.write(def, undefined, {
    patch: { direct: { host: '0.0.0.0' }, tunnel: { enabled: false } },
  });
  expect(widened.kind).toBe('held');
  expect(config.fileState(def).state).toBe('held');
  return { host, config, verdict };
}

it('M13 a tunnel switch beside a held loosening is in effect, and the held edit stays held and out of effect', async () => {
  const { host, config, verdict } = await heldWorld();
  try {
    verdict.now = 'apply';
    await writeTunnelSetting(config, def, true);

    expect(config.file(def as ConfigFileDef<unknown>)).toMatchObject({
      direct: { host: '127.0.0.1' },
      tunnel: { enabled: true },
    });
    expect(config.fileState(def).state).toBe('held');
  } finally {
    await host.stop();
  }
});

it('M13 a tunnel switch is made through writeAsOwner and no plain write, held edit or not', async () => {
  const { host, config, verdict } = await heldWorld();
  try {
    verdict.now = 'apply';
    const calls: string[] = [];
    const note =
      <Args extends unknown[], Result>(name: string, call: (...args: Args) => Result) =>
      (...args: Args): Result => {
        calls.push(name);
        return call(...args);
      };
    const seen: ConfigPort = {
      ...config,
      write: note('write', config.write),
      writeAsOwner: note('writeAsOwner', config.writeAsOwner),
    };

    await writeTunnelSetting(seen, def, true);

    expect(calls).toEqual(['writeAsOwner']);
  } finally {
    await host.stop();
  }
});
