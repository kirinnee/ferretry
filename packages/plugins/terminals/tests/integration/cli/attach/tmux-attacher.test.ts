import { afterEach, beforeEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  ambientTmuxEnvironment,
  BunTmuxAttachProcess,
  currentTmuxSocket,
  ExactTmuxAttacher,
  type ProcessStart,
  type TmuxAttachProcess,
} from '../../../../cli/adapters/attach/tmux-attacher.ts';
import { AttachError } from '../../../../cli/lib/attach/ports.ts';
import type { AttachTarget } from '../../../../cli/lib/protocol/attach-target.ts';

const TARGET: AttachTarget = {
  socketPath: '/run/fy/tmux.sock',
  tmuxSession: 'fy-wren',
  paneId: '%3',
  pid: 4242,
  processStartTicks: 900,
};

/** A tmux that is never real: it reports `observed` and records what it would have run. */
function fakeTmux(
  observed: { code?: number; stdout: string; stderr?: string },
  start: ProcessStart = { kind: 'known', value: 900 },
  executable: string | null = '/usr/bin/tmux',
) {
  const ran: (readonly string[])[] = [];
  const inspected: (readonly string[])[] = [];
  const process: TmuxAttachProcess = {
    executable: () => executable ?? undefined,
    inspect: async argv => {
      inspected.push(argv);
      return { code: observed.code ?? 0, stdout: observed.stdout, stderr: observed.stderr ?? '' };
    },
    interact: async argv => {
      ran.push(argv);
      return 0;
    },
    processStart: async () => start,
  };
  return { ran, inspected, process };
}

const refusal = async (attaching: Promise<number>): Promise<string> => {
  const failure = await attaching.then(
    () => undefined,
    (error: unknown) => error,
  );
  should(failure).be.instanceof(AttachError);
  return (failure as AttachError).message;
};

describe('the TMUX environment record', () => {
  const kept = process.env.TMUX;
  afterEach(() => {
    if (kept === undefined) delete process.env.TMUX;
    else process.env.TMUX = kept;
  });

  it('should hand the attach only the TMUX variable of this process', () => {
    // Arrange
    process.env.TMUX = '/run/fy/tmux.sock,77,0';

    // Act / Assert
    should(ambientTmuxEnvironment()).eql({ TMUX: '/run/fy/tmux.sock,77,0' });
    delete process.env.TMUX;
    should(ambientTmuxEnvironment()).eql({ TMUX: undefined });
  });

  it('should read the socket out of a TMUX record and nothing out of a malformed one', () => {
    // Arrange / Act / Assert
    should(currentTmuxSocket('/run/a,b/tmux.sock,77,0')).equal('/run/a,b/tmux.sock');
    should(currentTmuxSocket(undefined)).be.undefined();
    should(currentTmuxSocket('')).be.undefined();
    should(currentTmuxSocket('/run/tmux.sock')).be.undefined();
    should(currentTmuxSocket('/run/tmux.sock,1,0')).be.undefined();
    should(currentTmuxSocket('/run/tmux.sock,x,0')).be.undefined();
    should(currentTmuxSocket('/run/tmux.sock,77,-1')).be.undefined();
    should(currentTmuxSocket('relative,77,0')).be.undefined();
  });
});

describe('ExactTmuxAttacher', () => {
  it('should attach to the proved session once tmux reports the same pane, pid and start', async () => {
    // Arrange
    const { ran, inspected, process } = fakeTmux({ stdout: 'fy-wren\t%3\t4242\n' });

    // Act
    const code = await new ExactTmuxAttacher(process, {}).attach(TARGET);

    // Assert
    should(code).equal(0);
    should(inspected).eql([
      [
        '/usr/bin/tmux',
        '-S',
        '/run/fy/tmux.sock',
        'display-message',
        '-p',
        '-t',
        '%3',
        '#{session_name}\t#{pane_id}\t#{pane_pid}',
      ],
    ]);
    should(ran).eql([
      ['/usr/bin/tmux', '-S', '/run/fy/tmux.sock', 'select-pane', '-t', '%3', ';', 'attach-session', '-t', 'fy-wren'],
    ]);
  });

  it('should switch the client inside the same tmux server rather than nest', async () => {
    // Arrange
    const { ran, process } = fakeTmux({ stdout: 'fy-wren\t%3\t4242' });

    // Act
    await new ExactTmuxAttacher(process, { TMUX: '/run/fy/tmux.sock,77,0' }).attach(TARGET);

    // Assert
    should(ran[0]).containEql('switch-client');
    should(ran[0]).not.containEql('attach-session');
  });

  it('should refuse when tmux is not installed on this host', async () => {
    // Arrange
    const { ran, inspected, process } = fakeTmux({ stdout: '' }, undefined, null);

    // Act
    const message = await refusal(new ExactTmuxAttacher(process, {}).attach(TARGET));

    // Assert
    should(message).equal('tmux is not installed on this host');
    should([ran, inspected]).eql([[], []]);
  });

  it('should say what tmux said when it cannot report the pane, and a plain sentence when it said nothing', async () => {
    // Arrange
    const spoke = fakeTmux({ code: 1, stdout: '', stderr: " can't find pane: %3\n" });
    const silent = fakeTmux({ code: 1, stdout: '' });
    const garbled = fakeTmux({ stdout: 'fy-wren\tpane-3\t4242' });

    // Act / Assert
    should(await refusal(new ExactTmuxAttacher(spoke.process, {}).attach(TARGET))).equal("can't find pane: %3");
    const plain = 'tmux no longer reports the pane identity the daemon supplied';
    should(await refusal(new ExactTmuxAttacher(silent.process, {}).attach(TARGET))).equal(plain);
    should(await refusal(new ExactTmuxAttacher(garbled.process, {}).attach(TARGET))).equal(plain);
    should([spoke.ran, silent.ran, garbled.ran]).eql([[], [], []]);
  });

  it('should refuse, naming each failed check, when the pane no longer matches the proof', async () => {
    // Arrange
    const otherPane = fakeTmux({ stdout: 'other\t%9\t4242' });
    const otherPid = fakeTmux({ stdout: 'fy-wren\t%3\t99' });
    const otherStart = fakeTmux({ stdout: 'fy-wren\t%3\t4242' }, { kind: 'known', value: 901 });
    const gone = fakeTmux({ stdout: 'fy-wren\t%3\t4242' }, { kind: 'gone' });

    // Act
    const pane = await refusal(new ExactTmuxAttacher(otherPane.process, {}).attach(TARGET));
    const pid = await refusal(new ExactTmuxAttacher(otherPid.process, {}).attach(TARGET));
    const start = await refusal(new ExactTmuxAttacher(otherStart.process, {}).attach(TARGET));
    const dead = await refusal(new ExactTmuxAttacher(gone.process, {}).attach(TARGET));

    // Assert
    should(pane).containEql('tmux session is "other", the daemon proved "fy-wren"');
    should(pane).containEql('pane id is %9, the daemon proved %3');
    should(pid).containEql('pane pid is 99, the daemon proved 4242');
    should(start).containEql('process start identity is 901, the daemon proved 900');
    should(dead).containEql('pane process 4242 is no longer running');
    should(dead).containEql('refusing to attach');
    should([otherPane.ran, otherPid.ran, otherStart.ran, gone.ran]).eql([[], [], [], []]);
  });

  it('should go on, and say so, when the host has no source for the start identity', async () => {
    // Arrange
    const notices: string[] = [];
    const { ran, process } = fakeTmux(
      { stdout: 'fy-wren\t%3\t4242' },
      { kind: 'unavailable', reason: 'plan9 has no source for a process start identity' },
    );

    // Act
    const code = await new ExactTmuxAttacher(process, {}, message => notices.push(message)).attach(TARGET);

    // Assert
    should(code).equal(0);
    should(ran).have.length(1);
    should(notices).have.length(1);
    should(notices[0]).containEql('plan9 has no source for a process start identity');
    // With no notice sink given, the same attach still goes through quietly.
    should(await new ExactTmuxAttacher(process, {}).attach(TARGET)).equal(0);
  });

  it('should refuse a malformed TMUX record and a different tmux server, running nothing', async () => {
    // Arrange
    const malformed = fakeTmux({ stdout: 'fy-wren\t%3\t4242' });
    const elsewhere = fakeTmux({ stdout: 'fy-wren\t%3\t4242' });

    // Act
    const broken = await refusal(new ExactTmuxAttacher(malformed.process, { TMUX: 'not-a-record' }).attach(TARGET));
    const other = await refusal(
      new ExactTmuxAttacher(elsewhere.process, { TMUX: '/tmp/other.sock,77,0' }).attach(TARGET),
    );

    // Assert
    should(broken).containEql('the current TMUX environment is malformed');
    should(other).containEql('different tmux server');
    should([malformed.ran, elsewhere.ran]).eql([[], []]);
  });
});

describe('BunTmuxAttachProcess, against a stand-in tmux', () => {
  let work = '';

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'fy-tmux-attach-'));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  /** A `tmux` that is a shell script: it answers the identity query and logs every other call to a file. */
  const standInTmux = async (paneLine: string, exitCode: number): Promise<string> => {
    const log = join(work, 'tmux.log');
    const script = [
      '#!/bin/sh',
      'case "$*" in',
      `  *display-message*) printf '%s' '${paneLine}'; exit 0 ;;`,
      'esac',
      `printf '%s\\n' "$*" >> '${log}'`,
      `exit ${String(exitCode)}`,
      '',
    ].join('\n');
    await writeFile(join(work, 'tmux'), script);
    await chmod(join(work, 'tmux'), 0o755);
    return log;
  };

  it('should look tmux up on the path, and say where it is, without running it', () => {
    // Arrange: the path is the host's own and is not changed; whichever way it answers, nothing is run.
    const sut = new BunTmuxAttachProcess();

    // Act
    const found = sut.executable();

    // Assert
    if (found !== undefined) should(found.endsWith('/tmux')).be.true();
    else should(found).be.undefined();
  });

  it('should inspect with stdout, stderr and the exit code of the program it ran', async () => {
    // Arrange
    const sut = new BunTmuxAttachProcess();
    await standInTmux('fy-wren\t%3\t4242', 0);

    // Act
    const found = await sut.inspect([join(work, 'tmux'), 'display-message']);
    const failed = await sut.inspect(['/bin/sh', '-c', 'echo oops >&2; exit 3']);

    // Assert
    should(found).eql({ code: 0, stdout: 'fy-wren\t%3\t4242', stderr: '' });
    should(failed).eql({ code: 3, stdout: '', stderr: 'oops\n' });
  });

  it('should run the whole attach through the stand-in and hand back its exit code', async () => {
    // Arrange
    const real = new BunTmuxAttachProcess();
    const start = await real.processStart(process.pid);
    should(start.kind).equal('known');
    const log = await standInTmux(`fy-wren\t%3\t${String(process.pid)}`, 7);
    // The real process operations, except that the program is the stand-in script and never a real tmux.
    const sut: TmuxAttachProcess = {
      executable: () => join(work, 'tmux'),
      inspect: argv => real.inspect(argv),
      interact: argv => real.interact(argv),
      processStart: pid => real.processStart(pid),
    };
    const target: AttachTarget = {
      ...TARGET,
      pid: process.pid,
      processStartTicks: start.kind === 'known' ? start.value : 1,
    };

    // Act
    const code = await new ExactTmuxAttacher(sut, {}).attach(target);

    // Assert
    should(code).equal(7);
    should((await readFile(log, 'utf8')).trim()).equal(
      '-S /run/fy/tmux.sock select-pane -t %3 ; attach-session -t fy-wren',
    );
  });

  it('should read this process start identity, and call a process that is gone gone', async () => {
    // Arrange
    const sut = new BunTmuxAttachProcess();
    const finished = Bun.spawn(['/bin/sh', '-c', 'exit 0']);
    await finished.exited;

    // Act
    const own = await sut.processStart(process.pid);
    const again = await sut.processStart(process.pid);
    const dead = await sut.processStart(finished.pid);
    const invalid = await sut.processStart(0);
    const fractional = await sut.processStart(1.5);

    // Assert
    should(own.kind).equal('known');
    should(again).eql(own);
    should(dead).eql({ kind: 'gone' });
    should(invalid).eql({ kind: 'gone' });
    should(fractional).eql({ kind: 'gone' });
  });

  it('should read the start identity from ps on macOS and say a platform with no source has none', async () => {
    // Arrange: the platform is read when the adapter is built, so it is stood in for only while that happens.
    const real = Object.getOwnPropertyDescriptor(process, 'platform');
    const build = (platform: string): BunTmuxAttachProcess => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      try {
        return new BunTmuxAttachProcess();
      } finally {
        if (real !== undefined) Object.defineProperty(process, 'platform', real);
      }
    };
    const finished = Bun.spawn(['/bin/sh', '-c', 'exit 0']);
    await finished.exited;
    const mac = build('darwin');
    const other = build('win32');

    // Act
    const own = await mac.processStart(process.pid);
    const dead = await mac.processStart(finished.pid);
    const none = await other.processStart(process.pid);

    // Assert: `ps -o lstart=` is an epoch-seconds reading; the stand-in host may lack the fixed `ps` path.
    if (own.kind === 'known') {
      should(own.value).be.above(1_000_000_000);
      should(dead).eql({ kind: 'gone' });
    } else {
      should(own.kind).equal('unavailable');
    }
    should(none).eql({ kind: 'unavailable', reason: "win32 has no source for a process's start identity" });
  });
});
