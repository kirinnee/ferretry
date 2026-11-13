/** XX kernel.updateHost: the release, the executable facts, and one narrow detached launch. */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { defineState } from '../../../contract/define.ts';
import type { UpdateHostPort } from '../../../contract/ports.ts';
import { undeclaredUpdateHost, updateHostFor } from '../../../host/adapters/update-host.ts';
import { bootHost, type HostOptions } from '../../../host/host.ts';
import { state } from '../../../host/index.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const files = { report: 'update/report.json', log: 'update.log' };

const facts = {
  argv0: '/home/owner/.nix-profile/bin/fyd',
  execPath: '/nix/store/abc-ferretry/bin/fyd',
  main: '/$bunfs/root/fyd',
  workingDirectory: '/',
  platform: 'linux',
};

describe('XX kernel.updateHost', () => {
  test('the release, compiled, and the executable with its links resolved', async () => {
    const port = updateHostFor({
      home: '/home/owner/.ferretry',
      binary: 'fy',
      release: '5.0.0',
      process: facts,
      environment: {}, // not the process's: CI exports FY_UPDATE_CHECK=off, which would turn `checks` off
      resolveLink: async path => `${path}-resolved`,
      spawn: () => {
        throw new Error('no launch here');
      },
    })('updates', files);
    expect(port.release).toBe('5.0.0');
    expect(port.compiled).toBe(true);
    expect(port.checks).toBe(true);
    expect(await port.executable()).toEqual({ ...facts, resolvedExecPath: '/nix/store/abc-ferretry/bin/fyd-resolved' });
    const failing = updateHostFor({
      home: '/h',
      binary: 'fy',
      release: '5.0.0',
      process: { ...facts, main: '/src/fyd.ts' },
      environment: {},
      resolveLink: async () => {
        throw new Error('gone');
      },
    })('updates', files);
    expect(failing.compiled).toBe(false);
    expect(failing.checks).toBe(false);
    expect((await failing.executable()).resolvedExecPath).toBe(facts.execPath);
  });

  test('a target that is not a release number is refused without a launch', async () => {
    const launched: unknown[] = [];
    const port = updateHostFor({
      home: '/h',
      binary: 'fy',
      release: '5.0.0',
      process: facts,
      spawn: argv => launched.push(argv),
    })('updates', files);
    for (const bad of ['latest', '5.1', '5.1.0; rm -rf /', '--yes', '../5.1.0'])
      expect((await port.launchUpdate(bad)).kind).toBe('failed');
    expect(launched).toEqual([]);
  });

  test('the report and log sit under the plugin’s own state root, and a declared path with .. or * is refused with no launch', async () => {
    const launched: { argv: readonly string[]; logFile: string }[] = [];
    const make = (declared: { report: string; log: string }) =>
      updateHostFor({
        home: '/home/owner/.ferretry',
        binary: 'fy',
        release: '5.0.0',
        process: facts,
        spawn: (argv, options) => launched.push({ argv, logFile: options.logFile }),
      })('updates', declared);
    // the log directory is created for real, so run the good case under a throwaway home
    const root = await mkdtemp(`${tmpdir()}/update-root-`);
    roots.push(root);
    const good = updateHostFor({
      home: root,
      binary: 'fy',
      release: '5.0.0',
      process: facts,
      spawn: (argv, options) => launched.push({ argv, logFile: options.logFile }),
    })('updates', files);
    expect((await good.launchUpdate('5.1.0')).kind).toBe('started');
    expect(launched[0]?.argv.at(-1)).toBe(`${state.pluginStateRoot(root, 'updates')}/update/report.json`);
    expect(launched[0]?.logFile).toBe(`${state.pluginStateRoot(root, 'updates')}/update.log`);
    launched.length = 0;
    for (const bad of [
      { report: '../report.json', log: 'update.log' },
      { report: 'update/../../report.json', log: 'update.log' },
      { report: 'update/report.json', log: '*.log' },
      { report: 'update/*.json', log: 'update.log' },
    ]) {
      const port = make(bad);
      const answer = await port.launchUpdate('5.1.0');
      expect(answer.kind).toBe('failed');
      expect(answer).toMatchObject({ reason: expect.stringContaining('not one file inside its own state folder') });
      await expect(port.executable()).rejects.toThrow('state folder');
    }
    expect(launched).toEqual([]);
  });

  test('a plugin without permissions.updateHost gets facts that refuse and launches that fail', async () => {
    const seen: Record<string, UpdateHostPort> = {};
    const half = (id: string, updateHost?: true) =>
      implementDaemon(
        definePlugin({
          id,
          title: id,
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          ...(updateHost === undefined ? {} : { permissions: { updateHost } }),
        }),
        {
          build: ctx => {
            seen[id] = ctx.kernel.updateHost;
            return {};
          },
        },
      );
    const stand = { ...undeclaredUpdateHost('x', '5.0.0'), launchUpdate: async () => ({ kind: 'started' as const }) };
    const host = await testHost({ plugins: [half('updates', true), half('other')], updateHost: stand });
    expect((await seen['updates']?.launchUpdate('5.1.0'))?.kind).toBe('started');
    expect(await seen['other']?.launchUpdate('5.1.0')).toEqual({
      kind: 'failed',
      reason: 'other did not declare permissions.updateHost.',
    });
    await expect(seen['other']?.executable() ?? Promise.resolve()).rejects.toThrow('permissions.updateHost');
    await host.stop();
  });
});

describe("XX kernel.updateHost checks (FY_UPDATE_CHECK, today's update.ts: compiled AND not off)", () => {
  const check = (main: string, environment: Record<string, string | undefined>): boolean =>
    updateHostFor({
      home: '/h',
      binary: 'fy',
      release: '5.0.0',
      process: { ...facts, main },
      environment,
    })('updates', files).checks;
  test('a compiled build checks unless FY_UPDATE_CHECK is off', () => {
    expect(check('/$bunfs/root/fyd', {})).toBe(true);
    expect(check('/$bunfs/root/fyd', { FY_UPDATE_CHECK: 'on' })).toBe(true);
    expect(check('/$bunfs/root/fyd', { FY_UPDATE_CHECK: 'off' })).toBe(false);
  });
  test('a source run never checks, whatever the switch says', () => {
    expect(check('/src/fyd.ts', {})).toBe(false);
    expect(check('/src/fyd.ts', { FY_UPDATE_CHECK: 'on' })).toBe(false);
  });
  test('the stub a plugin without permissions.updateHost holds never checks', () => {
    expect(undeclaredUpdateHost('x', '5.0.0').checks).toBe(false);
  });
});

describe('XX kernel.updateHost launch -> report round trip', () => {
  // A report path that is NOT the host's old spelling, so a second hard-coded path would miss the file.
  const REPORT = defineState({
    name: 'report',
    path: 'last/update-report.json',
    store: 'json',
    format: 1,
    schema: z.object({ outcome: z.string() }),
  });
  const LOG = defineState({ name: 'log', path: 'last/update.out', store: 'opaque', format: 1 });

  test('a fake fy writes the report where --report says, and the plugin reads it through its declared state def', async () => {
    const root = await mkdtemp(`${tmpdir()}/update-roundtrip-`);
    roots.push(root);
    const home = `${root}/home`;
    const bin = `${root}/bin`;
    await Bun.write(`${bin}/.keep`, '');
    const argvLog = `${root}/argv.txt`;
    // The stand-in client: records its argv, then writes the report to whatever follows --report.
    await writeFile(
      `${bin}/fy`,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > '${argvLog}'`,
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "--report" ]; then',
        '    mkdir -p "$(dirname "$2")"',
        '    printf \'{"format":1,"outcome":"done"}\' > "$2"',
        '  fi',
        '  shift',
        'done',
        '',
      ].join('\n'),
    );
    await chmod(`${bin}/fy`, 0o755);
    const seen: { launch?: () => Promise<unknown>; read?: () => Promise<unknown> } = {};
    const updates = definePlugin({
      id: 'updates',
      title: 'Updates',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { updateHost: true },
      data: { state: [REPORT, LOG] },
    });
    const adapters: HostOptions['adapters'] = {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
      updateHost: updateHostFor({
        home,
        binary: 'fy',
        release: '5.0.0',
        process: { ...facts, argv0: `${bin}/fyd`, execPath: `${bin}/fyd`, workingDirectory: root },
        environment: { PATH: '/usr/bin:/bin' },
      }),
    };
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      adapters,
      implementations: [
        implementDaemon(updates, {
          build: ({ kernel }) => {
            seen.launch = async () => await kernel.updateHost.launchUpdate('5.1.0');
            seen.read = async () => await kernel.state.read(REPORT);
            return {};
          },
        }),
      ],
    });
    try {
      if (outcome.kind !== 'running') throw new Error(outcome.sentence);
      expect(await seen.launch?.()).toEqual({ kind: 'started' });
      let report: unknown;
      for (let attempt = 0; attempt < 100 && report === undefined; attempt += 1) {
        await Bun.sleep(50);
        const read = (await seen.read?.()) as { ok: boolean; value?: { outcome: string } } | undefined;
        report = read?.ok === true ? read.value : undefined;
      }
      expect(report).toEqual({ outcome: 'done' });
      expect(await readFile(`${home}/state/updates/last/update-report.json`, 'utf8')).toContain('"done"');
      expect((await readFile(argvLog, 'utf8')).trim().split('\n')).toEqual([
        'update',
        '--run',
        '--to',
        '5.1.0',
        '--report',
        `${home}/state/updates/last/update-report.json`,
      ]);
    } finally {
      if (outcome.kind === 'running') await outcome.host.stop();
    }
  });

  test('a plugin that declares updateHost but not the report and log files is refused, not given a guessed path', async () => {
    const seen: Record<string, UpdateHostPort> = {};
    const bare = implementDaemon(
      definePlugin({
        id: 'updates',
        title: 'Updates',
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: [],
        permissions: { updateHost: true },
      }),
      {
        build: ({ kernel }) => {
          seen['updates'] = kernel.updateHost;
          return {};
        },
      },
    );
    const root = await mkdtemp(`${tmpdir()}/update-undeclared-`);
    roots.push(root);
    const home = `${root}/home`;
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      adapters: {
        ...realAdapters(home, () => {}, { binary: 'fy' }),
        clock: fixedClock(),
        homeLock: async () => ({ release: async () => {} }),
        updateHost: updateHostFor({ home, binary: 'fy', release: '5.0.0', process: facts }),
      },
      implementations: [bare],
    });
    try {
      if (outcome.kind !== 'running') throw new Error(outcome.sentence);
      expect(await seen['updates']?.launchUpdate('5.1.0')).toEqual({
        kind: 'failed',
        reason: 'updates did not declare the state files report and log.',
      });
    } finally {
      if (outcome.kind === 'running') await outcome.host.stop();
    }
  });
});
