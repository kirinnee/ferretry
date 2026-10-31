import { describe, it } from 'bun:test';
import type { BrowserPortsSetting, LoopbackFirewallMarker } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import type { z } from 'zod';
import { registerBrowserCommands } from '../../../src/lib/browser/command';
import { BrowserController, type IBrowserRunner } from '../../../src/lib/browser/controller';
import { BROWSER_FIREWALL_MACHINE_PATH, browserRequest } from '../../../src/lib/browser/request';
import type { BrowserCommand } from '../../../src/lib/browser/types';
import { machine } from '../fleet/account-fakes';

const ENTRY: BrowserCommand = { command: 'firewall', action: 'entry' };
const EXPLICIT = { cdp: 9222, relay: 9223, vnc: 5901 };

function commandHarness() {
  const calls: BrowserCommand[] = [];
  const runner: IBrowserRunner = {
    run: async command => {
      calls.push(command);
      return 0;
    },
  };
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerBrowserCommands(program, runner);
  return { calls, run: (...argv: string[]) => program.parseAsync(['node', 'fy', ...argv]) };
}

function controllerHarness(
  browserPorts: BrowserPortsSetting | undefined,
  context: { uid?: number; marker?: LoopbackFirewallMarker; failWith?: unknown } = {},
) {
  const paths: string[] = [];
  const out: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const gateway = {
    request: async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
      paths.push(path);
      if (context.failWith !== undefined) throw context.failWith;
      return schema.parse(machine(browserPorts === undefined ? {} : { browserPorts }));
    },
  };
  const io = {
    success: (message: string) => out.push(message),
    warn: (message: string) => out.push(message),
    error: (message: string) => errors.push(message),
    setExitCode: (code: number) => exitCodes.push(code),
  };
  const controller = new BrowserController(
    gateway,
    io,
    { write: async () => {} },
    {
      ...(context.uid === undefined ? {} : { uid: context.uid }),
      loopbackMarker: async () => context.marker,
    },
  );
  return { paths, out, errors, exitCodes, run: () => controller.run(ENTRY) };
}

describe('firewall entry request', () => {
  it('should read the machine view, with no session in scope', () => {
    // Act
    const actual = browserRequest(ENTRY, 'sess-1');

    // Assert
    should(actual).deepEqual({ method: 'GET', path: BROWSER_FIREWALL_MACHINE_PATH });
    should(BROWSER_FIREWALL_MACHINE_PATH).equal('/v1/fleet/machine');
  });
});

describe('fy browser firewall entry', () => {
  it('should run the firewall entry command, and take no session', async () => {
    // Arrange
    const harness = commandHarness();

    // Act
    await harness.run('browser', 'firewall', 'entry');

    // Assert
    should(harness.calls).deepEqual([ENTRY]);
    await should(harness.run('browser', 'firewall', 'entry', '--session', 's')).be.rejected();
  });
});

describe('the firewall entry the controller prints', () => {
  it('should print `user <uid>` for per-user ports', async () => {
    // Arrange
    const harness = controllerHarness('per-user', { uid: 1001 });

    // Act
    const code = await harness.run();

    // Assert
    should(code).equal(0);
    should(harness.out).deepEqual(['user 1001']);
    should(harness.paths).deepEqual([BROWSER_FIREWALL_MACHINE_PATH]);
    should(harness.exitCodes).deepEqual([]);
  });

  it('should print the explicit line for explicit ports', async () => {
    // Arrange
    const harness = controllerHarness(EXPLICIT, { uid: 1001 });

    // Act
    const code = await harness.run();

    // Assert
    should(code).equal(0);
    should(harness.out).deepEqual(['user 1001 9222 9223 5901']);
  });

  it('should refuse per-user ports the base in the marker cannot hold', async () => {
    // Arrange
    const marker: LoopbackFirewallMarker = { version: 1, appliedAt: '2026-10-31T00:00:00Z', base: 32_766, entries: [] };
    const harness = controllerHarness('per-user', { uid: 1000, marker });

    // Act
    const code = await harness.run();

    // Assert
    should(code).equal(1);
    should(harness.errors[0]).containEql('from base 32766');
    should(harness.exitCodes).deepEqual([1]);
  });

  it('should say to set browserPorts first, with exit 1, when the setting is random or absent', async () => {
    // Arrange
    const random = controllerHarness('random', { uid: 1001 });
    const absent = controllerHarness(undefined, { uid: 1001 });

    // Act
    const codes = [await random.run(), await absent.run()];

    // Assert
    should(codes).deepEqual([1, 1]);
    should(random.errors[0]).containEql('set browserPorts first');
    should(absent.errors[0]).containEql('set browserPorts first');
    should(random.out).deepEqual([]);
    should(random.exitCodes).deepEqual([1]);
  });

  it('should say so, without asking the daemon, when the system gives no user id', async () => {
    // Arrange
    const harness = controllerHarness('per-user');

    // Act
    const code = await harness.run();

    // Assert
    should(code).equal(1);
    should(harness.errors[0]).containEql('no user id');
    should(harness.paths).deepEqual([]);
  });

  it('should say why the daemon could not be read, in one line with exit 1', async () => {
    // Arrange
    const harness = controllerHarness('per-user', { uid: 1001, failWith: new Error('the daemon is not running') });

    // Act
    const code = await harness.run();

    // Assert
    should(code).equal(1);
    should(harness.errors).deepEqual(['the daemon is not running']);
    should(harness.exitCodes).deepEqual([1]);
  });
});
