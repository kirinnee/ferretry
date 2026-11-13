/**
 * The host-built pieces of Runtimes' daemon (`daemon/host-assembly.ts`) over the testing host: the published fleet is
 * read through the `fleet` root, a runtime's wrapper is found by its name, and an ended Codex runtime's app-server pair
 * is stopped through `kernel.processes` — nothing read around the kernel.
 */
import { afterEach, describe, it } from 'bun:test';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import type { KernelPorts } from '@ferretry/kernel/contract';
import { testHost, testProcessTable } from '@ferretry/kernel/testing';
import should from 'should';
import { endedSeams, launchFactsSource } from '../../../daemon/host-assembly.ts';
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

  const EXPECTED_FACTS = { kind: 'claude', windows: { defaultModel: 'm', models: [{ id: 'm' }] } };

  it('should publish the kind and the model windows of a runtime, by name or by id, and nothing of its environment', async () => {
    const facts = await source({ 'manifest.json': JSON.stringify(claudeManifest) });

    should(await facts.facts('work')).deepEqual(EXPECTED_FACTS);
    should(await facts.facts(CLAUDE_ID)).deepEqual(EXPECTED_FACTS);
  });

  it('should still read a manifest whose account carries the legacy referencedEnv names, and say nothing of them', async () => {
    // v4 4.291.9 to 4.291.11 wrote this field; a manifest from then must not turn a start into a refusal.
    const facts = await source({ 'manifest.json': JSON.stringify(claudeManifest) });

    should(JSON.stringify(claudeManifest)).containEql('OTHER_KEY');
    should(await facts.facts('work')).deepEqual(EXPECTED_FACTS);
  });

  it('should say nothing of an unpublished runtime or a fleet nobody published', async () => {
    const facts = await source({ 'manifest.json': JSON.stringify(claudeManifest) });
    const empty = await source({});

    should(await facts.facts('other')).be.undefined();
    should(await empty.facts('work')).be.undefined();
  });

  it('should never read fixed.json: a stale env, a file that is not JSON and one of the wrong shape change nothing', async () => {
    // A project's own .claude env wins over a login's (owner, !A500): nothing is pinned, so nothing is read, and no
    // damaged file can refuse a start (v4 before 4.291.9 read none either).
    for (const text of [
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://gateway.invalid', LEAK: '${secret:K}', INDIRECT: '$OTHER' },
      }),
      '{ not json',
      'null',
      '[]',
      '{"env":{"ANTHROPIC_AUTH_TOKEN":42}}',
    ]) {
      const facts = await source({
        'manifest.json': JSON.stringify(claudeManifest),
        [`homes/${CLAUDE_ID}/.fy/fixed.json`]: text,
      });

      should(await facts.facts('work')).deepEqual(EXPECTED_FACTS);
    }
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

  it('should read the manifest inside the publication read, so a read waits for an apply in flight rather than the gap', async () => {
    const kernel = await kernelWith({ 'manifest.json': JSON.stringify(claudeManifest) });
    const publication = new FleetPublication();
    let finishApply!: () => void;
    const applying = publication.publishing(
      async () =>
        await new Promise<void>(resolve => {
          finishApply = resolve;
        }),
    );
    let read = false;

    const pending = launchFactsSource(kernel, publication)
      .facts('work')
      .then(facts => {
        read = true;
        return facts;
      });
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    should(read).be.false();
    finishApply();
    await applying;

    should(await pending).deepEqual(EXPECTED_FACTS);
  });
});
