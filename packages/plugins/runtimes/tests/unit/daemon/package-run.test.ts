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

/** A stream that reports being cancelled, so a test sees a reader stopped. */
function watched(text: string, cancelled: { count: number }) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text !== '') controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      cancelled.count += 1;
    },
  });
}

/** A stream of the given chunks, then its end. */
function chunks(parts: readonly Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
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
      ownGroup: true,
    });
    should(result).deepEqual({ kind: 'exited', code: 0, tail: ['==> Installed'] });
  });

  it('kills the whole group even when the manager exited by itself, then stops both readers', async () => {
    const out = { count: 0 };
    const err = { count: 0 };
    const { port, killed } = fakeSpawn({
      exited: Promise.resolve(0),
      stdout: watched('done\n', out),
      stderr: watched('', err),
    });
    const { clock, fire } = manualClock();
    const pending = packageRunner(() => port, clock)(RUN);
    await new Promise(resolve => setTimeout(resolve, 0));
    fire(1_000);
    const result = await pending;
    should(result).deepEqual({ kind: 'exited', code: 0, tail: ['done'] });
    should(killed).deepEqual(['SIGKILL']);
    should(out.count).equal(1);
    should(err.count).equal(1);
  });

  it('never starts sudo or a shell: the manifest may start brew, npm and uname only', () => {
    const spawn = manifest.permissions?.spawn ?? [];
    should([...spawn].sort()).deepEqual(['brew', 'npm', 'uname']);
  });

  it('kills the group at the deadline and returns only after the manager is gone and the readers are stopped', async () => {
    let end: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>(resolve => {
      end = resolve;
    });
    const out = { count: 0 };
    const { port, killed } = fakeSpawn({ exited, stdout: watched('', out), stderr: silent() });
    const { clock, fire } = manualClock();
    let settled = false;
    const pending = packageRunner(
      () => port,
      clock,
    )(RUN).then(result => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    fire(900_000);
    await new Promise(resolve => setTimeout(resolve, 0));
    should(killed).deepEqual(['SIGKILL']);
    // The manager has not exited yet: the run is not over, so the service's guard is not released.
    should(settled).equal(false);
    end(137);
    await new Promise(resolve => setTimeout(resolve, 0));
    fire(1_000);
    const result = await pending;
    should(result.kind).equal('timed-out');
    should(out.count).equal(1);
  });

  it('stops waiting for a manager that ignores the kill after a bounded grace', async () => {
    const { port } = fakeSpawn({ exited: new Promise(() => undefined), stdout: silent(), stderr: silent() });
    const { clock, fire } = manualClock();
    const pending = packageRunner(() => port, clock)(RUN);
    await Promise.resolve();
    fire(900_000);
    await new Promise(resolve => setTimeout(resolve, 0));
    fire(5_000);
    await new Promise(resolve => setTimeout(resolve, 0));
    fire(1_000);
    should((await pending).kind).equal('timed-out');
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

describe('packageRunner output bounds', () => {
  const run = async (parts: readonly Uint8Array[], code = 1) => {
    const { port } = fakeSpawn({ exited: Promise.resolve(code), stdout: chunks(parts), stderr: encode('') });
    const { clock, fire } = manualClock();
    const pending = packageRunner(() => port, clock)(RUN);
    await new Promise(resolve => setTimeout(resolve, 0));
    fire(1_000);
    const result = await pending;
    if (result.kind !== 'exited') throw new Error('expected an exit');
    return result.tail;
  };
  const filler = (length: number, letter = 'a') => new TextEncoder().encode(letter.repeat(length));

  it('cuts a long line split across chunks at the line limit, before it is decoded', async () => {
    const tail = await run([filler(700), filler(700), filler(700), new TextEncoder().encode('\nnext\n')]);
    should(tail).have.length(2);
    should(new TextEncoder().encode(tail[0] ?? '').length).equal(1_024);
    should(tail[1]).equal('next');
  });

  it('holds a fixed amount for a stream that never prints a newline', async () => {
    const parts = Array.from({ length: 2_000 }, () => filler(4_096));
    const tail = await run(parts);
    should(tail).have.length(1);
    should(new TextEncoder().encode(tail[0] ?? '').length).equal(1_024);
  });

  it('keeps at most forty lines and sixteen KiB when every line is long', async () => {
    const line = new Uint8Array([...filler(1_000), 0x0a]);
    const tail = await run(Array.from({ length: 100 }, () => line));
    should(tail.length).be.belowOrEqual(16);
    should(tail.reduce((total, entry) => total + new TextEncoder().encode(entry).length, 0)).be.belowOrEqual(16_384);
    const short = await run(Array.from({ length: 100 }, (_, index) => new TextEncoder().encode(`l${index}\n`)));
    should(short).have.length(40);
    should(short.at(-1)).equal('l99');
  });

  it('keeps stdout and stderr in one tail', async () => {
    const { port } = fakeSpawn({ exited: Promise.resolve(1), stdout: encode('out\n'), stderr: encode('err\n') });
    const { clock, fire } = manualClock();
    const pending = packageRunner(() => port, clock)(RUN);
    await new Promise(resolve => setTimeout(resolve, 0));
    fire(1_000);
    const result = await pending;
    should(result.kind === 'exited' ? [...result.tail].sort() : []).deepEqual(['err', 'out']);
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
