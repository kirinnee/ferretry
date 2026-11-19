/**
 * The real package-manager run behind a tool install (A9): the argv it starts is the declared one and nothing else, no
 * sudo, stdin closed, a deadline kills a stuck child, and the output a person sees is scrubbed.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { ChildHandle, Clock, SpawnOptions, SpawnPort } from '@ferretry/kernel/contract';
import { HostPlatform } from '../../../daemon/adapters/host-platform.ts';
import { packageRunner } from '../../../daemon/adapters/package-run.ts';
import { scrubInstallOutput } from '../../../daemon/lib/service/install-output.ts';
import manifest from '../../../manifest.ts';

const encode = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

const silent = () => new ReadableStream<Uint8Array>({ start: () => undefined });

/** A clock whose timers fire only when a test says so. */
function manualClock() {
  const timers: { delay: number; fn: () => void; live: boolean }[] = [];
  const clock = {
    after: (delay: number, fn: () => void) => {
      const timer = { delay, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  } as unknown as Clock;
  return {
    clock,
    fire: (delay: number) => {
      for (const timer of timers) if (timer.live && timer.delay === delay) timer.fn();
    },
  };
}

function fakeSpawn(child: Partial<ChildHandle> & { exited: Promise<number | null> }) {
  const started: { program: string; args: readonly string[]; options?: SpawnOptions }[] = [];
  const killed: (string | undefined)[] = [];
  const port: SpawnPort = {
    run: async () => {
      throw new Error('not used');
    },
    runBytes: async () => {
      throw new Error('not used');
    },
    start: (program, args, options) => {
      started.push({ program, args, ...(options === undefined ? {} : { options }) });
      return {
        pid: 1,
        stdout: encode(''),
        stderr: encode(''),
        write: () => undefined,
        kill: signal => void killed.push(signal),
        pipes: [],
        closePipes: () => undefined,
        ...child,
      };
    },
  };
  return { port, started, killed };
}

const RUN = {
  executable: '/opt/homebrew/bin/brew',
  args: ['install', '--cask', 'claude-code'],
  environment: { PATH: '/opt/homebrew/bin:/usr/bin', NONINTERACTIVE: '1', GONE: undefined },
  timeoutMs: 900_000,
} as const;

describe('packageRunner', () => {
  it('starts exactly the declared executable and argv, with stdin closed and only plain environment values', async () => {
    const { port, started } = fakeSpawn({ exited: Promise.resolve(0), stdout: encode('==> Installed\n') });
    const { clock } = manualClock();
    const result = await packageRunner(() => port, clock)(RUN);
    should(started).have.length(1);
    should(started[0]?.program).equal('/opt/homebrew/bin/brew');
    should(started[0]?.args).deepEqual(['install', '--cask', 'claude-code']);
    should(started[0]?.options).deepEqual({
      env: { PATH: '/opt/homebrew/bin:/usr/bin', NONINTERACTIVE: '1' },
      stdin: '',
    });
    should(result).deepEqual({ kind: 'exited', code: 0, tail: ['==> Installed'] });
  });

  it('never starts sudo or a shell: the manifest may start brew, npm and uname only', () => {
    const spawn = manifest.permissions?.spawn ?? [];
    should([...spawn].sort()).deepEqual(['brew', 'npm', 'uname']);
  });

  it('kills a child that outlives its deadline and says it timed out', async () => {
    const { port, killed } = fakeSpawn({ exited: new Promise(() => undefined), stdout: silent(), stderr: silent() });
    const { clock, fire } = manualClock();
    const pending = packageRunner(() => port, clock)(RUN);
    await Promise.resolve();
    fire(900_000);
    const result = await pending;
    should(result.kind).equal('timed-out');
    should(killed).deepEqual(['SIGKILL']);
  });

  it('reports a program that cannot be started, and a daemon with no spawn at all, as not started', async () => {
    const { clock } = manualClock();
    const throwing: SpawnPort = {
      run: async () => {
        throw new Error('x');
      },
      runBytes: async () => {
        throw new Error('x');
      },
      start: () => {
        throw new Error('brew may not run');
      },
    };
    should(await packageRunner(() => throwing, clock)(RUN)).deepEqual({
      kind: 'not-started',
      reason: 'brew may not run',
    });
    const missing = await packageRunner(() => {
      throw new Error('no spawn');
    }, clock)(RUN);
    should(missing).deepEqual({ kind: 'not-started', reason: 'no spawn' });
  });

  it('keeps the exit code of a failing manager and its last lines', async () => {
    const { port } = fakeSpawn({ exited: Promise.resolve(243), stderr: encode('npm ERR! code EACCES\n') });
    const { clock } = manualClock();
    const result = await packageRunner(() => port, clock)(RUN);
    should(result).deepEqual({ kind: 'exited', code: 243, tail: ['npm ERR! code EACCES'] });
  });
});

describe('scrubInstallOutput', () => {
  it('hides token-shaped words and secret-named assignments', () => {
    const shown = scrubInstallOutput([
      'fetching with npm_abcdefghijklmnop1234 now',
      'MY_API_KEY=abcdefghijkl1234',
      'plain progress 50%',
    ]);
    should(shown.join('\n')).not.containEql('npm_abcdef');
    should(shown.join('\n')).not.containEql('abcdefghijkl1234');
    should(shown.at(-1)).equal('plain progress 50%');
  });

  it('drops a line that names a credential whole', () => {
    const shown = scrubInstallOutput(['//registry.npmjs.org/:_authToken=anything', 'Authorization: Bearer abc']);
    should(shown.join('\n')).not.containEql('anything');
    should(shown.join('\n')).not.containEql('Bearer abc');
  });

  it('strips colour, cuts long lines and keeps the last twenty', () => {
    const lines = Array.from({ length: 30 }, (_, index) => `\u001b[32mline ${index}\u001b[0m`);
    const shown = scrubInstallOutput([...lines, 'x'.repeat(500)]);
    should(shown).have.length(20);
    should(shown.at(-1)?.length).equal(200);
    should(shown[0]).equal('line 11');
  });
});

describe('HostPlatform', () => {
  const answering = (stdout: string, exitCode = 0): SpawnPort => ({
    run: async () => ({ exitCode, signal: null, stdout, stderr: '' }),
    runBytes: async () => {
      throw new Error('not used');
    },
    start: () => {
      throw new Error('not used');
    },
  });

  it('is unknown until asked, then the lower-cased uname word', async () => {
    const platform = new HostPlatform(() => answering('Darwin\n'));
    should(platform.name()).equal('unknown');
    await platform.prime();
    should(platform.name()).equal('darwin');
  });

  it('stays unknown when uname fails, is refused, or there is no spawn', async () => {
    for (const source of [
      () => answering('', 1),
      () => {
        throw new Error('refused');
      },
      () => undefined,
    ]) {
      const platform = new HostPlatform(source);
      await platform.prime();
      should(platform.name()).equal('unknown');
    }
  });
});
