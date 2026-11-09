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
import { endedSeams } from '../../../daemon/host-assembly.ts';
import { buildFleetManifest } from '../../../daemon/lib/manifest.ts';
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
