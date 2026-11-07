import { describe, it } from 'bun:test';
import type { ChildHandle, FencedPath, SpawnOptions, SpawnPort, SpawnResult } from '@ferretry/kernel/contract';
import should from 'should';
import { HostCodexFacts } from '../../daemon/adapters/facts.ts';
import { HostPrograms } from '../../daemon/adapters/host-programs.ts';
import { NpmCodexLatest } from '../../daemon/adapters/npm-latest.ts';
import { packageRunner } from '../../daemon/adapters/package-run.ts';
import { HostCodexProbe, probeEnvironment } from '../../daemon/adapters/probe.ts';
import { locateCodex } from '../../daemon/lib/index.ts';
import { realClock } from '../support/ports.ts';

type Answer = Partial<SpawnResult> | 'throws';

/** A host whose small system programs answer from a script, and which records every question it was asked. */
class Scripted implements SpawnPort {
  readonly asked: { program: string; args: readonly string[]; options?: SpawnOptions }[] = [];
  constructor(private readonly answer: (program: string, args: readonly string[]) => Answer) {}

  async run(program: string, args: readonly string[], options?: SpawnOptions): Promise<SpawnResult> {
    this.asked.push({ program, args, ...(options === undefined ? {} : { options }) });
    const answer = this.answer(program, args);
    if (answer === 'throws') throw new Error(`${program} is not declared`);
    return { exitCode: 0, signal: null, stdout: '', stderr: '', ...answer };
  }

  start(): ChildHandle {
    throw new Error('not started here');
  }

  async runBytes(): Promise<never> {
    throw new Error('not used here');
  }
}

describe('what the host says about programs', () => {
  it('resolves a name through `which`, and answers nothing for a program that is missing or refused', async () => {
    const host = new HostPrograms(
      new Scripted(program => (program === 'which' ? { stdout: '/usr/bin/npm\n' } : 'throws')),
    );
    should(await host.resolve('npm')).equal('/usr/bin/npm');
    const none = new HostPrograms(new Scripted(() => ({ exitCode: 1 })));
    should(await none.resolve('npm')).be.undefined();
    should(await new HostPrograms(new Scripted(() => 'throws')).resolve('npm')).be.undefined();
  });

  it('asks `test` whether an absolute path is a runnable file, and refuses a relative one without asking', async () => {
    const scripted = new Scripted(() => ({}));
    const host = new HostPrograms(scripted);
    should(await host.runnable('/opt/bin/codex')).be.true();
    should(await host.runnable('codex')).be.false();
    should(scripted.asked.map(question => question.program)).eql(['test']);
  });

  it('keeps the path when it cannot be resolved, and says no link where there is none', async () => {
    const host = new HostPrograms(new Scripted(() => ({ exitCode: 1 })));
    should(await host.realpath('/opt/bin/codex')).equal('/opt/bin/codex');
    should(await host.readLink('/opt/bin/codex')).be.undefined();
  });

  it('reads an environment name through `printenv`, a lower-cased platform, and an unparsable nix listing as nothing', async () => {
    const host = new HostPrograms(
      new Scripted((program, args) => {
        if (program === 'printenv') return { stdout: `${args[0]}-value\n` };
        if (program === 'uname') return { stdout: 'Darwin\n' };
        return { stdout: 'not json' };
      }),
    );
    should(await host.environment('HOME')).equal('HOME-value');
    should(await host.platform()).equal('darwin');
    should(await host.nixProfile()).be.undefined();
  });
});

describe('the facts about a Codex file', () => {
  it('reads links and the nix profile only for a file in the Nix store', async () => {
    const scripted = new Scripted((program, args) => {
      if (program === 'realpath') return { stdout: `${args[0]}\n` };
      if (program === 'printenv') return { stdout: '/home/kirin\n' };
      if (program === 'uname') return { stdout: 'Linux\n' };
      return { exitCode: 1 };
    });
    const facts = await new HostCodexFacts(new HostPrograms(scripted)).facts('/opt/bin/codex');
    should(facts).eql({
      launchedPath: '/opt/bin/codex',
      resolvedPath: '/opt/bin/codex',
      homeDirectory: '/home/kirin',
      platform: 'linux',
    });
    should(scripted.asked.map(question => question.program)).not.containEql('readlink');
    should(scripted.asked.map(question => question.program)).not.containEql('nix');
  });
});

describe('asking the Codex binary about itself', () => {
  const HOME = '/state/codex/agent-homes/probe' as FencedPath;

  it('runs it in a throwaway home with every proxy pointed at nothing and its own directory first on PATH', () => {
    const environment = probeEnvironment('/opt/bin/codex', HOME, { PATH: '/usr/bin' });
    should(environment).containDeep({
      HOME,
      CODEX_HOME: `${HOME}/.codex`,
      PATH: '/opt/bin:/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      CI: '1',
    });
  });

  const probeOver = (answer: (program: string, args: readonly string[]) => Answer) => {
    const scripted = new Scripted(answer);
    return { scripted, probe: new HostCodexProbe(scripted, new HostPrograms(scripted), HOME) };
  };

  it('reads the version it prints', async () => {
    const { probe, scripted } = probeOver(() => ({ stdout: 'codex-cli 0.145.0\n' }));
    should(await probe.version('/opt/bin/codex')).eql({ state: 'ok', version: '0.145.0' });
    const run = scripted.asked.find(question => question.program === '/opt/bin/codex');
    should(run?.args).eql(['--version']);
    should(run?.options?.env).containDeep({ HOME });
  });

  it('says why a version could not be read: no version printed, killed at the deadline, or a refused spawn', async () => {
    should((await probeOver(() => ({ stdout: 'nothing' })).probe.version('/opt/bin/codex')).state).equal('unreadable');
    should(
      await probeOver(program => (program === '/opt/bin/codex' ? { exitCode: null } : {})).probe.version(
        '/opt/bin/codex',
      ),
    ).containDeep({ state: 'unreadable', reason: 'it did not answer within 20 seconds' });
    should(
      await probeOver(program => (program === '/opt/bin/codex' ? 'throws' : {})).probe.version('/opt/bin/codex'),
    ).containDeep({ state: 'unreadable', reason: '/opt/bin/codex is not declared' });
  });

  it('checks that it starts by asking for --help', async () => {
    should(await probeOver(() => ({})).probe.startup('/opt/bin/codex')).eql({ ok: true });
    should(
      await probeOver(program => (program === '/opt/bin/codex' ? { exitCode: 1 } : {})).probe.startup('/opt/bin/codex'),
    ).eql({
      ok: false,
      reason: '--help exited 1',
    });
  });
});

describe('the newest published Codex', () => {
  const clock = realClock();
  const fetchOf = (response: () => Response | Promise<Response>) => ({ request: async () => await response() });

  it('reads the registry answer', async () => {
    const latest = new NpmCodexLatest(
      fetchOf(() => Response.json({ version: '0.145.0' })),
      clock,
      'ferretry',
    );
    should(await latest.latest()).containDeep({ kind: 'ok', release: { version: '0.145.0' } });
  });

  it('says what went wrong without throwing: unreachable, a bad status, or an answer with no stable version', async () => {
    const unreachable = new NpmCodexLatest(
      fetchOf(() => Promise.reject(new Error('offline'))),
      clock,
      'ferretry',
    );
    should(await unreachable.latest()).eql({ kind: 'failed', reason: 'could not reach npm' });
    const bad = new NpmCodexLatest(
      fetchOf(() => new Response('', { status: 503 })),
      clock,
      'ferretry',
    );
    should(await bad.latest()).eql({ kind: 'failed', reason: 'npm answered 503' });
    const odd = new NpmCodexLatest(
      fetchOf(() => Response.json({ version: '1.0.0-rc.1' })),
      clock,
      'ferretry',
    );
    should(await odd.latest()).eql({ kind: 'failed', reason: 'npm did not name a stable version' });
  });
});

describe('where Codex is', () => {
  const executables = (runnable: readonly string[], onPath?: string) => ({
    resolve: async () => onPath,
    runnable: async (path: string) => runnable.includes(path),
  });

  it('takes an explicit binary as an instruction, expanding ~, and never searches on when it is missing', async () => {
    should(
      await locateCodex(
        { binary: '~/bin/codex', searchPaths: [] },
        executables(['/home/kirin/bin/codex']),
        '/home/kirin',
      ),
    ).eql({
      outcome: 'located',
      path: '/home/kirin/bin/codex',
      rule: 'explicit override',
      declaredBy: 'harness-codex.yaml binary',
    });
    const missing = await locateCodex(
      { binary: '/nope/codex', searchPaths: [] },
      executables([], '/usr/bin/codex'),
      '/home/kirin',
    );
    should(missing).containDeep({ outcome: 'override-absent', path: '/nope/codex' });
  });

  it('tries the search directories in order, then what the daemon inherited, then says where it looked', async () => {
    should(
      await locateCodex({ searchPaths: ['/a', '/b'] }, executables(['/b/codex'], '/usr/bin/codex'), '/home/kirin'),
    ).containDeep({ outcome: 'located', path: '/b/codex', rule: 'extra search path' });
    should(await locateCodex({ searchPaths: ['/a'] }, executables([], '/usr/bin/codex'), '/home/kirin')).containDeep({
      outcome: 'located',
      path: '/usr/bin/codex',
      rule: 'inherited environment',
    });
    should(await locateCodex({ searchPaths: ['/a'] }, executables([]), '/home/kirin')).eql({
      outcome: 'absent',
      searched: ['/a'],
    });
  });
});

/** A manager child whose output and exit the test controls. */
function manager(options: {
  readonly lines?: readonly string[];
  readonly code?: number | null;
  readonly never?: boolean;
}) {
  const encoder = new TextEncoder();
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  const killed: (string | undefined)[] = [];
  const child: ChildHandle = {
    pid: 1,
    stdout: stream(`${(options.lines ?? []).join('\n')}\n`),
    stderr: stream(''),
    write: () => {
      throw new Error('stdin is never written');
    },
    kill: signal => killed.push(signal),
    pipes: [],
    closePipes: () => undefined,
    exited: options.never === true ? new Promise<number | null>(() => undefined) : Promise.resolve(options.code ?? 0),
  };
  const spawn: SpawnPort = {
    run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
    runBytes: async () => {
      throw new Error('not used here');
    },
    start: () => child,
  };
  return { spawn, killed };
}

describe('running a package manager', () => {
  const host = (spawn: SpawnPort) => new HostPrograms(spawn);

  it('keeps the tail of what it said and its exit code', async () => {
    const { spawn } = manager({ lines: ['added 1 package'], code: 0 });
    const run = packageRunner(spawn, realClock(), host(spawn));
    should(await run({ executable: '/usr/bin/npm', args: ['install'], timeoutMs: 5_000 })).eql({
      kind: 'exited',
      code: 0,
      tail: ['added 1 package'],
    });
  });

  it('kills a manager that outlives its deadline and says so', async () => {
    const { spawn, killed } = manager({ never: true, lines: ['still going'] });
    const run = packageRunner(spawn, realClock(), host(spawn));
    should(await run({ executable: '/usr/bin/npm', args: ['install'], timeoutMs: 20 })).containDeep({
      kind: 'timed-out',
    });
    should(killed).eql(['SIGKILL']);
  });

  it('says a manager that could not start', async () => {
    const spawn: SpawnPort = {
      run: async () => ({ exitCode: 1, signal: null, stdout: '', stderr: '' }),
      runBytes: async () => {
        throw new Error('not used here');
      },
      start: () => {
        throw new Error('npm is not declared');
      },
    };
    should(
      await packageRunner(spawn, realClock(), host(spawn))({ executable: '/usr/bin/npm', args: [], timeoutMs: 100 }),
    ).eql({
      kind: 'not-started',
      reason: 'npm is not declared',
    });
  });
});
