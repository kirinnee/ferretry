import { describe, it } from 'bun:test';
import should from 'should';
import type { ChildEnvironment, ChildEnvironmentOpener, HandleCommandLookup } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { RealHarnessLaunchGuard } from '../../../../daemon/adapters/tmux/harness-launch-guard.ts';
import { RealHarnessRefusedError, UnprovableHarnessError } from '../../../../daemon/lib/tmux/harness-guard.ts';

/**
 * The launch guard over the REAL `kernel.paths.whichFor` (`whichForCommand`, through the kernel's testing host), not a
 * stand-in: a launch whose handle sets a PATH the lookup cannot search to the end must be REFUSED, never read as "no
 * real harness here". The fixture is a real-looking install in the LAST folder of a PATH longer than the 64 the lookup
 * searches; a shell finds it, so the guard must not call the PATH clean.
 */
const REAL_INSTALL = '/fixture/home/.claude/local';
const handle = { names: ['PATH'] } as unknown as ChildEnvironment;
const requester = 'guard-host';

const fillers = (count: number): string[] => Array.from({ length: count }, (_, index) => `/fixture/missing-${index}`);

/** A plugin that hands the kernel's own `whichFor` to the guard, the way the terminals plugin wires it. */
async function guardOver(handlePath: string): Promise<{ guard: RealHarnessLaunchGuard; stop: () => Promise<void> }> {
  const opener: ChildEnvironmentOpener = {
    open: () => undefined,
    searchPathOf: (env, readers) => (env === handle && readers.includes(requester) ? handlePath : undefined),
  };
  let whichFor: ((name: string, env: ChildEnvironment) => Promise<HandleCommandLookup>) | undefined;
  const host = await testHost({
    plugins: [
      implementDaemon(
        definePlugin({
          id: requester,
          title: requester,
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          permissions: { which: true },
        }),
        {
          build: ({ kernel }) => {
            whichFor = async (name, env) => await kernel.paths.whichFor(name, env);
            return {};
          },
        },
      ),
    ],
    searchPath: '/fixture/daemon-bin',
    executables: [`${REAL_INSTALL}/claude`],
    childEnvironments: opener,
  });
  if (whichFor === undefined) throw new Error('the guard plugin was not built');
  const guard = new RealHarnessLaunchGuard(() => '/fixture/daemon-bin', undefined, whichFor);
  return { guard, stop: async () => await host.stop() };
}

const launch = { session: 'work', cwd: '/', command: ['claude'] as [string], envNames: ['PATH'], handle };

describe('RealHarnessLaunchGuard over the real kernel.paths.whichFor', () => {
  it('should refuse a real install in a folder past the 64th of the handle PATH', async () => {
    // Arrange: 64 missing folders, then the install: the old lookup stopped at the 64th and said `absent`.
    const subject = await guardOver([...fillers(64), REAL_INSTALL].join(':'));

    try {
      // Act
      const actual = await subject.guard.check(launch).catch((error: unknown) => error);

      // Assert
      should(actual).be.instanceOf(UnprovableHarnessError);
      should((actual as UnprovableHarnessError).why).equal('own-path');
    } finally {
      await subject.stop();
    }
  });

  it('should refuse a handle PATH with an empty entry, which a shell reads as the working folder', async () => {
    // Arrange
    const subject = await guardOver(`/fixture/missing-0::${REAL_INSTALL}`);

    try {
      // Act
      const actual = await subject.guard.check(launch).catch((error: unknown) => error);

      // Assert
      should(actual).be.instanceOf(UnprovableHarnessError);
    } finally {
      await subject.stop();
    }
  });

  it('should still judge a PATH it searched to the end: a real install within the bound is refused as one', async () => {
    // Arrange
    const subject = await guardOver([...fillers(63), REAL_INSTALL].join(':'));

    try {
      // Act
      const actual = await subject.guard.check(launch).catch((error: unknown) => error);

      // Assert
      should(actual).be.instanceOf(RealHarnessRefusedError);
      should((actual as RealHarnessRefusedError).install).equal('the Claude Code local install');
    } finally {
      await subject.stop();
    }
  });

  it('should allow a fully searched PATH that holds no harness at all', async () => {
    // Arrange
    const subject = await guardOver(fillers(64).join(':'));

    try {
      // Act
      const actual = await subject.guard.check(launch).then(() => 'allowed');

      // Assert
      should(actual).equal('allowed');
    } finally {
      await subject.stop();
    }
  });
});
