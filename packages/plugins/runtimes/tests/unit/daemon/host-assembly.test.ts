/**
 * The host-built pieces of Runtimes' daemon (`daemon/host-assembly.ts`) over the testing host: the published fleet is
 * read through the `fleet` root, a runtime's wrapper is found by its name, and an ended Codex runtime's app-server pair
 * is stopped through `kernel.processes` — nothing read around the kernel.
 */
import { afterEach, describe, it } from 'bun:test';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import type { KernelPorts, RootHandle } from '@ferretry/kernel/contract';
import { testHost, testProcessTable } from '@ferretry/kernel/testing';
import should from 'should';
import { endedSeams, launchFactsSource } from '../../../daemon/host-assembly.ts';
import { FixedSettingsDamagedError } from '../../../daemon/lib/launch-gate.ts';
import { buildFleetManifest } from '../../../daemon/lib/manifest.ts';
import { FleetPublication } from '../../../daemon/lib/service/publication.ts';
import { autoResumeSwitch } from '../../../daemon/lib/service/auto-resume-answer.ts';

const ID = '00000000-0000-4000-8000-000000000001';
const HOME = `/fleet/homes/${ID}`;
const WRAPPER = '/fleet/bin/codex-work';
const SERVER = `${HOME}/packages/app-server-daemon/releases/1/bin/codex app-server`;

const manifest = buildFleetManifest({
  generatedAt: '2027-01-15T08:00:00.000Z',
  accounts: [
    {
      id: ID,
      kind: 'codex',
      mode: 'auto',
      wrapper: WRAPPER,
      home: HOME,
      displayName: 'Codex',
      defaultModel: 'm',
      models: [{ id: 'm', displayName: 'M', available: true }],
      available: true,
      unavailableReason: null,
    },
  ],
  runtimes: [
    {
      id: ID,
      name: 'codex-work',
      harness: 'codex',
      credential: 'c',
      profile: 'p',
      agent: true,
      wrapper: WRAPPER,
      models: [],
      defaultModel: null,
    },
  ],
});

const stoppers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stoppers.splice(0)) await stop();
});

async function world(published: boolean) {
  const seen: { kernel?: KernelPorts } = {};
  const table = testProcessTable({
    processes: [{ pid: 100, commandLine: SERVER, environment: { CODEX_HOME: HOME } }],
  });
  const host = await testHost({
    plugins: [
      implementDaemon(
        definePlugin({
          id: 'runtimes',
          title: 'Runtimes',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          permissions: { roots: ['fleet'], processes: { environment: ['CODEX_HOME'] } },
        }),
        {
          build: ({ kernel }) => {
            seen.kernel = kernel;
            return {};
          },
        },
      ),
    ],
    processes: table,
  });
  stoppers.push(async () => await host.stop());
  const kernel = seen.kernel as KernelPorts;
  const fleet = kernel.roots.root('fleet');
  const at = (path: string) => {
    const resolved = fleet.resolve(path);
    if (!resolved.ok) throw new Error(resolved.error);
    return resolved.value;
  };
  if (published) await fleet.writeText(at('manifest.json'), JSON.stringify(manifest));
  await fleet.writeText(at(`homes/${ID}/packages/app-server-daemon/releases/1/codex`), '#!/bin/sh');
  await fleet.writeText(at(`homes/${ID}/app-server-daemon/daemon.pid`), '{"pid":100}');
  return { seams: endedSeams(kernel), signals: table.signals };
}

describe('endedSeams', () => {
  it('should find a runtime’s published wrapper by its name', async () => {
    const { seams } = await world(true);

    should(await seams.wrapperOf('codex-work')).equal(WRAPPER);
    should(await seams.wrapperOf('unpublished')).be.undefined();
  });

  it('should stop the app-server pair of an ended Codex runtime through the kernel', async () => {
    const { seams, signals } = await world(true);

    const outcome = await seams.supervisor.afterSessionEnded(WRAPPER);

    should(outcome).deepEqual({ kind: 'stopped', home: HOME, pids: [100] });
    should(signals).deepEqual([{ pid: 100, signal: 'SIGTERM' }]);
  });

  it('should leave everything running, and say so, when no fleet was ever published', async () => {
    const { seams, signals } = await world(false);

    should(await seams.wrapperOf('codex-work')).be.undefined();
    should(await seams.supervisor.afterSessionEnded(WRAPPER)).deepEqual({ kind: 'not-a-codex-runtime' });
    should(signals).deepEqual([]);
  });
});

describe('autoResumeSwitch', () => {
  it('should read left out, or no file at all, as on, and a stated value as stated', () => {
    should(autoResumeSwitch('absent', undefined)).equal(true);
    should(autoResumeSwitch('valid', {})).equal(true);
    should(autoResumeSwitch('valid', { autoResume: false })).equal(false);
    should(autoResumeSwitch('held', { autoResume: true })).equal(true);
  });

  it('should say nothing for a broken file with no last good version, which resumes nothing', () => {
    should(autoResumeSwitch('invalid', undefined)).be.undefined();
  });
});

describe('launchFactsSource', () => {
  const CLAUDE_ID = '00000000-0000-4000-8000-000000000002';
  const CLAUDE_HOME = `/fleet/homes/${CLAUDE_ID}`;
  const claudeManifest = buildFleetManifest({
    generatedAt: '2027-01-15T08:00:00.000Z',
    accounts: [
      {
        id: CLAUDE_ID,
        kind: 'claude',
        mode: 'auto',
        wrapper: '/fleet/bin/claude-work',
        home: CLAUDE_HOME,
        displayName: 'Work',
        defaultModel: 'm',
        models: [{ id: 'm', displayName: 'M', available: true }],
        available: true,
        unavailableReason: null,
        secretEnv: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' },
        referencedEnv: ['OTHER_KEY'],
      },
    ],
    runtimes: [
      {
        id: CLAUDE_ID,
        name: 'work',
        harness: 'claude',
        credential: 'c',
        profile: 'p',
        agent: true,
        wrapper: '/fleet/bin/claude-work',
        models: [],
        defaultModel: null,
      },
    ],
  });

  async function kernelWith(files: Readonly<Record<string, string>>): Promise<KernelPorts> {
    const seen: { kernel?: KernelPorts } = {};
    const host = await testHost({
      plugins: [
        implementDaemon(
          definePlugin({
            id: 'runtimes',
            title: 'Runtimes',
            version: '5.0.0',
            api: 5,
            core: false,
            kinds: [],
            permissions: { roots: ['fleet'] },
          }),
          {
            build: ({ kernel }) => {
              seen.kernel = kernel;
              return {};
            },
          },
        ),
      ],
    });
    stoppers.push(async () => await host.stop());
    const kernel = seen.kernel as KernelPorts;
    const fleet = kernel.roots.root('fleet');
    for (const [path, text] of Object.entries(files)) {
      const resolved = fleet.resolve(path);
      if (!resolved.ok) throw new Error(resolved.error);
      await fleet.writeText(resolved.value, text);
    }
    return kernel;
  }

  async function source(files: Readonly<Record<string, string>>) {
    return launchFactsSource(await kernelWith(files));
  }

  it('should publish the login’s names and the literal pins of its fixed settings, by name or by id', async () => {
    const facts = await source({
      'manifest.json': JSON.stringify(claudeManifest),
      [`homes/${CLAUDE_ID}/.fy/fixed.json`]: JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://gateway.invalid', LEAK: '${secret:K}', INDIRECT: '$OTHER' },
      }),
    });

    const expected = {
      runtime: 'work',
      kind: 'claude',
      secretEnvNames: ['ANTHROPIC_API_KEY'],
      referencedEnv: ['OTHER_KEY'],
      pins: { ANTHROPIC_BASE_URL: 'https://gateway.invalid' },
      windows: { defaultModel: 'm', models: [{ id: 'm' }] },
    };
    should(await facts.facts('work')).deepEqual(expected);
    should(await facts.facts(CLAUDE_ID)).deepEqual(expected);
  });

  it('should publish no pins for a runtime with no fixed settings or none that pin anything', async () => {
    const none = await source({ 'manifest.json': JSON.stringify(claudeManifest) });
    const noEnv = await source({
      'manifest.json': JSON.stringify(claudeManifest),
      [`homes/${CLAUDE_ID}/.fy/fixed.json`]: JSON.stringify({ permissions: {} }),
    });

    should((await none.facts('work'))?.pins).deepEqual({});
    should((await noEnv.facts('work'))?.pins).deepEqual({});
  });

  it('should say nothing of an unpublished runtime or a fleet nobody published', async () => {
    const facts = await source({ 'manifest.json': JSON.stringify(claudeManifest) });
    const empty = await source({});

    should(await facts.facts('other')).be.undefined();
    should(await empty.facts('work')).be.undefined();
  });

  it('should refuse, rather than guess, fixed settings that are not JSON', async () => {
    const facts = await source({
      'manifest.json': JSON.stringify(claudeManifest),
      [`homes/${CLAUDE_ID}/.fy/fixed.json`]: '{ not json',
    });

    await should(facts.facts('work')).be.rejectedWith(/not valid JSON/u);
  });

  it('should refuse, naming the file and never a value, a PRESENT fixed.json of the wrong shape', async () => {
    for (const text of [
      'null',
      '[]',
      '42',
      '"text"',
      '{"env":[]}',
      '{"env":null}',
      '{"env":"x"}',
      '{"env":{"ANTHROPIC_AUTH_TOKEN":42,"ANTHROPIC_BASE_URL":"fixture-value-7788"}}',
    ]) {
      const facts = await source({
        'manifest.json': JSON.stringify(claudeManifest),
        [`homes/${CLAUDE_ID}/.fy/fixed.json`]: text,
      });

      const refused = await facts.facts('work').then(
        () => undefined,
        (error: unknown) => error,
      );

      should(refused).be.instanceOf(FixedSettingsDamagedError);
      should((refused as Error).message).match(/fixed\.json/u);
      should((refused as Error).message).not.match(/fixture-value-7788/u);
    }
  });

  it('should keep a document with other keys, and an empty env, as the deliberate "pins nothing / pins what it holds"', async () => {
    const other = await source({
      'manifest.json': JSON.stringify(claudeManifest),
      [`homes/${CLAUDE_ID}/.fy/fixed.json`]: JSON.stringify({ theme: 'dark', env: { A: 'literal' } }),
    });
    const empty = await source({
      'manifest.json': JSON.stringify(claudeManifest),
      [`homes/${CLAUDE_ID}/.fy/fixed.json`]: '{"env":{}}',
    });

    should((await other.facts('work'))?.pins).deepEqual({ A: 'literal' });
    should((await empty.facts('work'))?.pins).deepEqual({});
  });

  it('should publish the compaction trigger of the account when it is a number, and none for auto', async () => {
    const withCompact = (compactAt: unknown) => ({
      ...claudeManifest,
      accounts: [{ ...claudeManifest.accounts[0], compactAt }],
    });
    const numeric = await source({ 'manifest.json': JSON.stringify(withCompact(200_000)) });
    const auto = await source({ 'manifest.json': JSON.stringify(withCompact('auto')) });

    should((await numeric.facts('work'))?.compactAt).equal(200_000);
    should('compactAt' in ((await auto.facts('work')) ?? {})).be.false();
  });

  it('should read the manifest AND the fixed settings inside ONE publication read, so an apply cannot land between them', async () => {
    const kernel = await kernelWith({
      'manifest.json': JSON.stringify(claudeManifest),
      [`homes/${CLAUDE_ID}/.fy/fixed.json`]: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.invalid' } }),
    });
    const publication = new FleetPublication();
    const realRoot = kernel.roots.root('fleet');
    let appliedDuringRead = false;
    let applying: Promise<void> | undefined;
    // The moment the source looks for the fixed settings, an apply queues and (if it were let in) removes them.
    const root = new Proxy(realRoot, {
      get(target, key) {
        if (key === 'lstat')
          return async (path: Parameters<RootHandle['lstat']>[0]) => {
            if (String(path).endsWith('/.fy/fixed.json')) {
              applying = publication.publishing(async () => {
                appliedDuringRead = true;
                await realRoot.remove(path);
              });
              // A publishing callback runs at once when nothing holds the gate: it would remove the file now.
              await Promise.resolve();
              if (appliedDuringRead) await applying;
            }
            return await target.lstat(path);
          };
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });

    const facts = await launchFactsSource({ roots: { ...kernel.roots, root: () => root } }, publication).facts('work');
    await applying;

    // The apply waited for the read to finish: the read saw the generation it started on, not the gap.
    should(facts?.pins).deepEqual({ ANTHROPIC_BASE_URL: 'https://gateway.invalid' });
  });
});
