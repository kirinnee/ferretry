import { describe, it } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionAttachTarget } from '@ferretry/protocol';
import should from 'should';
import {
  BunTmuxAttachProcess,
  currentTmuxSocket,
  ExactTmuxAttacher,
  parseProcessStartTicks,
  type TmuxAttachCommandResult,
  type TmuxAttachProcess,
} from '../../../src/adapters/reads/tmux-attacher.ts';

/**
 * The attach adapter is the last gate before a human's terminal is handed to a process.
 *
 * Everything here is about what it REFUSES. The daemon's proof is a claim about an incarnation that
 * may already be gone by the time the client acts on it, so the adapter re-observes the pane and
 * compares the whole identity — session, pane, pid and process start ticks — before it does anything
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
  readonly ticks?: number | undefined;
  readonly code?: number;
}

/** The host operations, recorded rather than performed, so no test ever reaches a real tmux server. */
class ScriptedTmuxProcess implements TmuxAttachProcess {
  readonly inspected: string[][] = [];
  readonly interacted: string[][] = [];
  readonly ticksAsked: number[] = [];

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

  async processStartTicks(pid: number): Promise<number | undefined> {
    this.ticksAsked.push(pid);
    return 'ticks' in this.script ? this.script.ticks : TARGET.processStartTicks;
  }
}

const attaching = (script: TmuxScript = {}, environment: Record<string, string | undefined> = {}) => {
  const host = new ScriptedTmuxProcess(script);
  return { host, subject: new ExactTmuxAttacher(host, environment) };
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

describe('reading a process start time out of procfs', () => {
  const statLine = (startTicks: number, comm = 'bash'): string =>
    `1234 (${comm}) S ${Array.from({ length: 18 }, (_, index) => index).join(' ')} ${startTicks} 0 0`;

  it('should read the start ticks past a command name that contains its own parentheses', () => {
    // Arrange — a process may rename itself to anything, including text with spaces and brackets.
    const plain = statLine(555_111);
    const awkward = statLine(555_111, 'my (weird) name');

    // Act + Assert — parsing from the LAST bracket is what keeps the field offsets true.
    should(parseProcessStartTicks(plain)).equal(555_111);
    should(parseProcessStartTicks(awkward)).equal(555_111);
  });

  it('should report nothing rather than a wrong number for unusable stat text', () => {
    // Arrange
    const truncated = '1234 (bash) S 0 1 2';
    const unparseable = `1234 (bash) S ${Array.from({ length: 18 }, () => 0).join(' ')} not-a-number 0`;
    const zero = statLine(0);

    // Act + Assert — undefined never matches a recorded tick count, so it always refuses the attach.
    should(parseProcessStartTicks(truncated)).be.undefined();
    should(parseProcessStartTicks(unparseable)).be.undefined();
    should(parseProcessStartTicks(zero)).be.undefined();
  });
});

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
    should(host.ticksAsked).eql([TARGET.pid]);
    should(host.interacted).eql([interactArgv('attach-session')]);
    should(actual).equal(7);
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

  it('should refuse every way the live pane can differ from the daemon proof', async () => {
    // Arrange — a reused pane name, a reused pane id, a reused pid, and a reused pid slot.
    const cases: TmuxScript[] = [
      { inspect: { stdout: 'fy-other\t%7\t4242' } },
      { inspect: { stdout: 'fy-s1\t%9\t4242' } },
      { inspect: { stdout: 'fy-s1\t%7\t9999' }, ticks: TARGET.processStartTicks },
      { ticks: 111_111 },
      { ticks: undefined },
    ];

    // Act
    const results = await Promise.all(cases.map(script => refusal(script)));

    // Assert — the start ticks are what distinguish a recycled pid from the original process.
    for (const { error, host } of results) {
      should((error as Error).message).equal(
        'the live pane no longer matches the daemon attach proof; refusing to attach',
      );
      should(host.interacted).be.empty();
    }
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

  it('should read this process own start ticks and refuse an unreadable pid', async () => {
    // Arrange
    const subject = new BunTmuxAttachProcess();

    // Act
    const own = await subject.processStartTicks(process.pid);
    const missing = await subject.processStartTicks(2_147_483_646);

    // Assert — on a host without procfs there is no evidence, and no evidence must refuse the attach.
    if (process.platform === 'linux') {
      should(own).equal(parseProcessStartTicks(await Bun.file(`/proc/${process.pid}/stat`).text()));
      should(own).be.above(0);
    } else {
      should(own).be.undefined();
    }
    should(missing).be.undefined();
  });
});
