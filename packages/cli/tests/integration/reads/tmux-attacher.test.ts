import { describe, it } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionAttachTarget } from '@ferretry/protocol';
import { processIncarnationFor } from '@ferretry/protocol/process-incarnation';
import should from 'should';
import {
  BunTmuxAttachProcess,
  currentTmuxSocket,
  ExactTmuxAttacher,
  type ProcessStart,
  type TmuxAttachCommandResult,
  type TmuxAttachProcess,
} from '../../../src/adapters/reads/tmux-attacher.ts';

/**
 * The attach adapter is the last gate before a human's terminal is handed to a process.
 *
 * Everything here is about what it REFUSES. The daemon's proof is a claim about an incarnation that
 * may already be gone by the time the client acts on it, so the adapter re-observes the pane and
 * compares the whole identity — session, pane, pid and process start identity — before it does anything
 * irreversible. A mismatch on any one of them means the name now addresses somebody else's terminal.
 */

const TARGET: SessionAttachTarget = {
  socketPath: '/run/user/1000/fy/tmux.sock',
  tmuxSession: 'fy-s1',
  paneId: '%7',
  pid: 4_242,
  processStartTicks: 987_654,
};

const TMUX = '/usr/bin/tmux';

const INSPECT_ARGV = [
  TMUX,
  '-S',
  TARGET.socketPath,
  'display-message',
  '-p',
  '-t',
  TARGET.paneId,
  '#{session_name}\t#{pane_id}\t#{pane_pid}',
];

const interactArgv = (action: string): string[] => [
  TMUX,
  '-S',
  TARGET.socketPath,
  'select-pane',
  '-t',
  TARGET.paneId,
  ';',
  action,
  '-t',
  TARGET.tmuxSession,
];

interface TmuxScript {
  readonly tmux?: string | undefined;
  readonly inspect?: Partial<TmuxAttachCommandResult>;
  readonly start?: ProcessStart;
  readonly code?: number;
}

/** The host operations, recorded rather than performed, so no test ever reaches a real tmux server. */
class ScriptedTmuxProcess implements TmuxAttachProcess {
  readonly inspected: string[][] = [];
  readonly interacted: string[][] = [];
  readonly startsAsked: number[] = [];

  constructor(private readonly script: TmuxScript = {}) {}

  executable(): string | undefined {
    return 'tmux' in this.script ? this.script.tmux : TMUX;
  }

  async inspect(argv: readonly string[]): Promise<TmuxAttachCommandResult> {
    this.inspected.push([...argv]);
    return { code: 0, stdout: 'fy-s1\t%7\t4242', stderr: '', ...this.script.inspect };
  }

  async interact(argv: readonly string[]): Promise<number> {
    this.interacted.push([...argv]);
    return this.script.code ?? 0;
  }

  async processStart(pid: number): Promise<ProcessStart> {
    this.startsAsked.push(pid);
    return this.script.start ?? { kind: 'known', value: TARGET.processStartTicks };
  }
}

const attaching = (script: TmuxScript = {}, environment: Record<string, string | undefined> = {}) => {
  const host = new ScriptedTmuxProcess(script);
  const notices: string[] = [];
  return { host, notices, subject: new ExactTmuxAttacher(host, environment, message => notices.push(message)) };
};

const refusal = async (
  script: TmuxScript = {},
  environment: Record<string, string | undefined> = {},
): Promise<{ error: unknown; host: ScriptedTmuxProcess }> => {
  const { host, subject } = attaching(script, environment);
  const error = await subject.attach(TARGET).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  return { error, host };
};

describe('reading the ambient tmux socket', () => {
  it('should take the socket path off a real TMUX record, commas in the path included', () => {
    // Arrange — tmux appends `,pid,index`, so only the trailing two fields are structure.
    const plain = '/tmp/tmux-1000/default,4242,0';
    const commas = '/tmp/odd,name.sock,4242,0';

    // Act + Assert
    should(currentTmuxSocket(plain)).equal('/tmp/tmux-1000/default');
    should(currentTmuxSocket(commas)).equal('/tmp/odd,name.sock');
  });

  it('should report nothing for an absent, truncated, or relative TMUX record', () => {
    // Act + Assert — a relative socket cannot be compared with the daemon's absolute one.
    should(currentTmuxSocket(undefined)).be.undefined();
    should(currentTmuxSocket('')).be.undefined();
    should(currentTmuxSocket('/tmp/tmux.sock,4242')).be.undefined();
    should(currentTmuxSocket('relative.sock,4242,0')).be.undefined();
  });
});

describe('handing the terminal to a daemon-proved pane', () => {
  it('should re-observe the exact pane before attaching from outside tmux', async () => {
    // Arrange
    const { host, subject } = attaching({ code: 7 });

    // Act
    const actual = await subject.attach(TARGET);

    // Assert — the daemon-supplied socket and pane id are addressed directly; nothing is guessed.
    should(host.inspected).eql([INSPECT_ARGV]);
    should(host.startsAsked).eql([TARGET.pid]);
    should(host.interacted).eql([interactArgv('attach-session')]);
    should(actual).equal(7);
  });

  it('should attach to the first pane of a fresh tmux server, which is %0', async () => {
    // Arrange — the daemon's private server numbers its first pane 0, and the wire schema allows it.
    const first: SessionAttachTarget = { ...TARGET, paneId: '%0' };
    const host = new ScriptedTmuxProcess({ inspect: { stdout: 'fy-s1\t%0\t4242' } });

    // Act
    const actual = await new ExactTmuxAttacher(host, {}).attach(first);

    // Assert
    should(actual).equal(0);
    should(host.interacted).have.length(1);
  });

  it('should switch the current client when it already lives on that same tmux server', async () => {
    // Arrange
    const { host, subject } = attaching({}, { TMUX: `${TARGET.socketPath},900,0` });

    // Act
    await subject.attach(TARGET);

    // Assert — attaching from inside the same server would nest a client inside itself.
    should(host.interacted).eql([interactArgv('switch-client')]);
  });

  it('should refuse when tmux is not installed at all', async () => {
    // Act
    const { error, host } = await refusal({ tmux: undefined });

    // Assert
    should((error as Error).message).equal('tmux is not installed on this host');
    should(host.inspected).be.empty();
  });

  it('should surface the tmux complaint when the pane can no longer be inspected', async () => {
    // Act
    const { error, host } = await refusal({
      inspect: { code: 1, stdout: '', stderr: "can't find pane: %7\n" },
    });

    // Assert
    should((error as Error).message).equal("can't find pane: %7");
    should(host.interacted).be.empty();
  });

  it('should still refuse when a failed inspection says nothing at all', async () => {
    // Act
    const { error } = await refusal({ inspect: { code: 1, stdout: '', stderr: '   ' } });

    // Assert — a silent failure must not read as an empty-but-valid identity.
    should((error as Error).message).equal('tmux no longer reports the pane identity the daemon supplied');
  });

  it('should refuse identity output it cannot read as exactly one pane', async () => {
    // Arrange — every one of these would otherwise be compared field-by-field against nothing.
    const outputs = [
      '\t%7\t4242',
      'fy-s1\tpane-7\t4242',
      'fy-s1\t%7\tnot-a-pid',
      'fy-s1\t%7\t1',
      'fy-s1\t%7\t4242\textra',
    ];

    // Act
    const errors = await Promise.all(outputs.map(async stdout => (await refusal({ inspect: { stdout } })).error));

    // Assert
    for (const error of errors)
      should((error as Error).message).equal('tmux no longer reports the pane identity the daemon supplied');
  });

  it('should name the check that failed for every way the live pane can differ from the daemon proof', async () => {
    // Arrange — a reused pane name, a reused pane id, a reused pid, a reused pid slot, and a dead process.
    const cases: readonly [TmuxScript, string][] = [
      [{ inspect: { stdout: 'fy-other\t%7\t4242' } }, 'tmux session is "fy-other", the daemon proved "fy-s1"'],
      [{ inspect: { stdout: 'fy-s1\t%9\t4242' } }, 'pane id is %9, the daemon proved %7'],
      [{ inspect: { stdout: 'fy-s1\t%7\t9999' } }, 'pane pid is 9999, the daemon proved 4242'],
      [{ start: { kind: 'known', value: 111_111 } }, 'process start identity is 111111, the daemon proved 987654'],
      [{ start: { kind: 'gone' } }, 'pane process 4242 is no longer running'],
    ];

    // Act
    const results = await Promise.all(cases.map(async ([script]) => await refusal(script)));

    // Assert — the start identity is what distinguishes a recycled pid from the original process.
    results.forEach(({ error, host }, index) => {
      should((error as Error).message).equal(
        `the live pane no longer matches the daemon attach proof (${cases[index]?.[1]}); refusing to attach`,
      );
      should(host.interacted).be.empty();
    });
  });

  it('should not read a process start identity for a pid the daemon did not prove', async () => {
    // Act
    const { host } = await refusal({ inspect: { stdout: 'fy-s1\t%7\t9999' } });

    // Assert — another process's start time cannot vouch for this proof.
    should(host.startsAsked).be.empty();
  });

  it('should report every failed check at once rather than only the first', async () => {
    // Act
    const { error } = await refusal({ inspect: { stdout: 'fy-other\t%9\t4242' }, start: { kind: 'known', value: 1 } });

    // Assert
    should((error as Error).message).equal(
      'the live pane no longer matches the daemon attach proof (tmux session is "fy-other", the daemon proved "fy-s1"; pane id is %9, the daemon proved %7; process start identity is 1, the daemon proved 987654); refusing to attach',
    );
  });

  it('should attach on session, pane and pid, and say so, when the host has no start identity source', async () => {
    // Arrange
    const { host, notices, subject } = attaching({
      start: { kind: 'unavailable', reason: 'sessions cannot start on freebsd' },
      code: 3,
    });

    // Act
    const actual = await subject.attach(TARGET);

    // Assert — no source is the absence of evidence, not evidence of a recycled pid; the proof is the
    // daemon's own observation moments ago, and a reader is told which check was skipped.
    should(actual).equal(3);
    should(host.interacted).eql([interactArgv('attach-session')]);
    should(notices).eql([
      "could not check the pane's process start identity (sessions cannot start on freebsd); attaching on the tmux session, pane id and pid the daemon just proved",
    ]);
  });

  it('should attach without a notice sink when the start identity source is unavailable', async () => {
    // Arrange — a caller that wires no sink still gets the attach; the notice is courtesy, not a gate.
    const host = new ScriptedTmuxProcess({ start: { kind: 'unavailable', reason: 'no source' } });

    // Act
    const actual = await new ExactTmuxAttacher(host, {}).attach(TARGET);

    // Assert
    should(actual).equal(0);
  });

  it('should still refuse a mismatched pane when the start identity source is unavailable', async () => {
    // Act
    const { error, host } = await refusal({
      inspect: { stdout: 'fy-other\t%7\t4242' },
      start: { kind: 'unavailable', reason: 'no source' },
    });

    // Assert — a missing check never widens what the remaining ones accept.
    should((error as Error).message).startWith('the live pane no longer matches the daemon attach proof (tmux session');
    should(host.interacted).be.empty();
  });

  it('should stay silent when every check ran', async () => {
    // Act
    const { notices, subject } = attaching();
    await subject.attach(TARGET);

    // Assert
    should(notices).be.empty();
  });

  it('should refuse to choose a server when the ambient TMUX record is malformed', async () => {
    // Act
    const { error, host } = await refusal({}, { TMUX: 'garbage' });

    // Assert
    should((error as Error).message).equal(
      'the current TMUX environment is malformed; refusing to choose an attach server',
    );
    should(host.interacted).be.empty();
  });

  it('should refuse to touch a client that belongs to a different tmux server', async () => {
    // Act
    const { error, host } = await refusal({}, { TMUX: '/tmp/someone-else.sock,900,0' });

    // Assert — switching that client would move a terminal the operator never asked about.
    should((error as Error).message).equal(
      'this terminal is attached to a different tmux server; detach from it before attaching to the session',
    );
    should(host.interacted).be.empty();
  });

  it('should treat an empty TMUX variable as being outside tmux', async () => {
    // Arrange — a cleared variable is what a detached shell in a tmux-started session leaves behind.
    const { host, subject } = attaching({}, { TMUX: '' });

    // Act
    await subject.attach(TARGET);

    // Assert
    should(host.interacted).eql([interactArgv('attach-session')]);
  });
});

describe('the real tmux and procfs operations', () => {
  it('should resolve tmux from the ambient PATH and report its absence honestly', async () => {
    // Arrange — PATH is read once per process, so each answer needs its own process to be real.
    const directory = await mkdtemp(join(tmpdir(), 'fy-tmux-path-'));
    const planted = join(directory, 'tmux');
    await Bun.write(planted, '#!/bin/sh\nexit 0\n');
    await chmod(planted, 0o755);
    const module = join(import.meta.dir, '../../../src/adapters/reads/tmux-attacher.ts');
    const program = `import { BunTmuxAttachProcess } from ${JSON.stringify(module)};
      process.stdout.write(JSON.stringify(new BunTmuxAttachProcess().executable() ?? null));`;
    const resolveWith = async (path: string): Promise<unknown> => {
      const child = Bun.spawn([process.execPath, '-e', program], {
        cwd: join(import.meta.dir, '../../..'),
        env: { PATH: path },
        stdout: 'pipe',
        stderr: 'inherit',
      });
      await child.exited;
      return JSON.parse(await new Response(child.stdout).text());
    };

    try {
      // Act
      const found = await resolveWith(directory);
      const missing = await resolveWith(join(directory, 'empty'));
      const ambient = new BunTmuxAttachProcess().executable();

      // Assert — an absent tmux must be `undefined`, not the `null` Bun.which actually returns.
      should(found).equal(planted);
      should(missing).be.null();
      // Whatever this host has, the answer is a resolved absolute path or nothing — never a bare name,
      // which `Bun.spawn` would then look up again against a PATH that may not be this one.
      should(ambient === undefined || ambient.startsWith('/')).be.true();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should capture both streams and the exit code of an inspection', async () => {
    // Arrange
    const subject = new BunTmuxAttachProcess();

    // Act
    const ok = await subject.inspect(['/bin/sh', '-c', 'printf ready']);
    const failed = await subject.inspect(['/bin/sh', '-c', 'printf nope >&2; exit 3']);

    // Assert — stderr must survive, because it becomes the operator's refusal message.
    should(ok).eql({ code: 0, stdout: 'ready', stderr: '' });
    should(failed.code).equal(3);
    should(failed.stderr).equal('nope');
  });

  it('should return the status of an interactive handover', async () => {
    // Arrange
    const subject = new BunTmuxAttachProcess();

    // Act + Assert — the exit code is the command's own answer, and `fy attach` adopts it.
    should(await subject.interact(['/bin/sh', '-c', 'exit 0'])).equal(0);
    should(await subject.interact(['/bin/sh', '-c', 'exit 5'])).equal(5);
  });

  it('should read this process own start identity through the shared source, and call a missing pid gone', async () => {
    // Arrange
    const subject = new BunTmuxAttachProcess();

    // Act
    const own = await subject.processStart(process.pid);
    const again = await subject.processStart(process.pid);
    const missing = await subject.processStart(2_147_483_646);

    // Assert — the number is the daemon's own: it is read by the module the daemon registers panes with.
    should(own.kind).equal('known');
    should(again).eql(own);
    should(own).eql({ kind: 'known', value: (await processIncarnationFor().startOf(process.pid)) as number });
    should(missing).eql({ kind: 'gone' });
  });

  it('should call a platform with no start identity source unavailable and say why', async () => {
    // Arrange
    const subject = new BunTmuxAttachProcess(processIncarnationFor('freebsd'));

    // Act
    const actual = await subject.processStart(process.pid);

    // Assert
    should(actual.kind).equal('unavailable');
    should(actual.kind === 'unavailable' && actual.reason).match(/sessions cannot start on freebsd/u);
  });

  it('should describe a thrown non-error by its text', async () => {
    // Arrange
    const subject = new BunTmuxAttachProcess({
      startOf: async () => {
        throw 'no source';
      },
    });

    // Act + Assert
    should(await subject.processStart(1)).eql({ kind: 'unavailable', reason: 'no source' });
  });
});

describe('attaching to a real tmux pane through the daemon proof', () => {
  it('should accept the proof the daemon builds from the same start identity, on this kernel', async () => {
    // Arrange — a private tmux server with one real pane, and the proof exactly as the daemon forms it:
    // tmux's own pane identity plus the shared start identity of the pane's process.
    const tmux = Bun.which('tmux');
    if (tmux === null) throw new Error('tmux is required for the real attach proof');
    const directory = await mkdtemp(join(tmpdir(), 'fy-attach-'));
    const socketPath = join(directory, 't.sock');
    const run = async (...argv: string[]): Promise<string> => {
      const child = Bun.spawn([tmux, '-S', socketPath, ...argv], { stdout: 'pipe', stderr: 'pipe' });
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`tmux ${argv.join(' ')} failed: ${err}`);
      return out.trim();
    };
    try {
      await run('new-session', '-d', '-s', 'fy-proof', 'sleep 600');
      const [tmuxSession = '', paneId = '', rawPid = ''] = (
        await run('display-message', '-p', '-t', 'fy-proof', '#{session_name}\t#{pane_id}\t#{pane_pid}')
      ).split('\t');
      const pid = Number(rawPid);
      const ticks = await processIncarnationFor().startOf(pid);
      should(ticks).be.a.Number();
      const target: SessionAttachTarget = {
        socketPath,
        tmuxSession,
        paneId,
        pid,
        processStartTicks: ticks as number,
      };
      const real = new BunTmuxAttachProcess();
      const interacted: string[][] = [];
      const host: TmuxAttachProcess = {
        executable: () => real.executable(),
        inspect: async argv => await real.inspect(argv),
        // An attach needs a terminal; the claim here is that the proof is accepted and the right argv is chosen.
        interact: async argv => {
          interacted.push([...argv]);
          return 0;
        },
        processStart: async value => await real.processStart(value),
      };
      const notices: string[] = [];

      // Act
      const accepted = await new ExactTmuxAttacher(host, {}, message => notices.push(message)).attach(target);
      const refused = await new ExactTmuxAttacher(host, {})
        .attach({ ...target, processStartTicks: target.processStartTicks + 1 })
        .then(
          () => undefined,
          (thrown: unknown) => thrown as Error,
        );

      // Assert — before this check read the shared source, a macOS pane could never be attached to.
      should(accepted).equal(0);
      should(notices).be.empty();
      should(interacted).eql([
        [tmux, '-S', socketPath, 'select-pane', '-t', paneId, ';', 'attach-session', '-t', 'fy-proof'],
      ]);
      should(refused?.message).startWith(
        'the live pane no longer matches the daemon attach proof (process start identity',
      );
    } finally {
      await run('kill-server').catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
