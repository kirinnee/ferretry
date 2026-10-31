import { describe, it } from 'bun:test';
import type { InputTargetFacts } from '@ferretry/protocol';
import should from 'should';
import { digestFacts, digestLine } from '../../../src/lib/input-requests/digest.ts';
import type { ProgramProofPort, ProvenProgram } from '../../../src/lib/input-requests/ports.ts';
import type { TerminalModes } from '../../../src/lib/input-requests/terminal-modes.ts';
import {
  foregroundPids,
  parseForeground,
  type TerminalLocator,
  TmuxInputTarget,
} from '../../../src/lib/input-requests/terminal-target.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../src/lib/tmux/contracts.ts';

const SESSION = 'fy-webterm-Hadi-0a1b2c3d-abc123abc123';
const PANE = `${SESSION}:0.0`;
const SECRET = 'hunter2-UNIQUE';
const PS = ' 4242  4242  4300 bash -bash\n 4300  4300  4300 /usr/bin/sudo sudo -v\n 4301  4300  4300 sudo sudo -v\n';

const ok = (stdout: string): TmuxCommandResult => ({ code: 0, stdout, stderr: '' });
const failed: TmuxCommandResult = { code: 1, stdout: '', stderr: "can't find pane" };

interface World {
  proof: string;
  command: string;
  cursor: number;
  display: TmuxCommandResult | undefined;
  capture: TmuxCommandResult;
  write: TmuxCommandResult;
  throwOnSend: boolean;
  ps: string | undefined;
  echo: 'off' | 'on' | 'unknown';
  located: boolean;
  /** Runs before tmux answers a call: the world changing under the daemon while it is looking or writing. */
  before: ((call: readonly string[], w: World) => void) | undefined;
  calls: (readonly string[])[];
  /** What tmux actually typed: the keys of a send-keys its own condition let through. */
  typed: (readonly string[])[];
  ran: (readonly string[])[];
  /**
   * The pane's pty buffer: what send-keys ENQUEUED. A program reads it later, so who it reaches is whoever
   * is in the foreground (and whatever echo is) when the read happens, not when the predicate was evaluated.
   */
  queued: (readonly string[])[];
  /** Runs after tmux's condition held and the bytes were enqueued, before any program reads them. */
  afterEnqueue: ((w: World) => void) | undefined;
  /** What the line-mode read answers; absent: the modes cannot tell. */
  canonical?: boolean;
  /** What the kernel proves each pid runs; a pid not here is unproved. */
  proved: Record<number, ProvenProgram>;
  /** Whether a process of another session holds the TTY open; `undefined`: it cannot be told. */
  elsewhere: boolean | undefined;
  /** The TTYs the daemon asked about strangers on. */
  askedElsewhere: string[];
}

/** A real sudo at its password prompt: running setuid root, so the kernel proves it whatever it is called. */
const SUDO: ProvenProgram = { name: 'sudo', setuidRoot: true };

const world = (): World => ({
  proof: '%3|4242|0|1700000000',
  command: 'sudo',
  cursor: 7,
  display: undefined,
  capture: ok('[sudo] password for kirin:                       \n'),
  write: ok(''),
  throwOnSend: false,
  ps: PS,
  echo: 'off',
  located: true,
  before: undefined,
  calls: [],
  typed: [],
  ran: [],
  queued: [],
  afterEnqueue: undefined,
  proved: { 4300: SUDO, 4301: SUDO },
  elsewhere: false,
  askedElsewhere: [],
});

const GUARD = /#\{==:#\{(\w+)\},([^}]*)\}/gu;

/** tmux evaluating an `if-shell -F` condition in its own server: every comparison must hold of the world NOW. */
function holds(condition: string, w: World): boolean {
  const live: Record<string, string> = {
    pane_pid: w.proof.split('|')[1] ?? '',
    pane_current_command: w.command,
    cursor_y: String(w.cursor),
    pane_dead: (w.proof.split('|')[2] ?? '0') === '1' ? '1' : '0',
  };
  const comparisons = [...condition.matchAll(GUARD)];
  return comparisons.length > 0 && comparisons.every(([, name = '', value = '']) => live[name] === value);
}

function target(w: World, programs?: { codeProgram(pid: number): Promise<boolean> }): TmuxInputTarget {
  const tmux: TmuxCommandPort = {
    execute: async args => {
      w.calls.push(args);
      w.before?.(args, w);
      if (args[0] === 'display-message') return w.display ?? ok(`${w.proof}\t/dev/pts/9\t${w.cursor}\t${w.command}\n`);
      if (args[0] === 'capture-pane') return w.capture;
      if (args[0] === 'if-shell') {
        if (w.throwOnSend) throw new Error('socket closed');
        if (w.write.code !== 0) return w.write;
        if (!holds(args[4] ?? '', w)) return ok(`${args[6]?.split(' ').at(-1)}\n`);
        const keys = (args[5] ?? '').split(' ');
        w.typed.push(keys);
        w.queued.push(keys);
        w.afterEnqueue?.(w);
        return w.write;
      }
      return failed;
    },
  };
  const terminals: TerminalLocator = {
    locate: async () => (w.located ? { tmuxSession: SESSION, id: 't-dev' } : undefined),
  };
  const modes: TerminalModes = {
    echo: async () => w.echo,
    ...(w.canonical === undefined ? {} : { canonical: async () => w.canonical }),
  };
  const proofs: ProgramProofPort = {
    prove: async pid => w.proved[pid],
    heldElsewhere: async tty => {
      w.askedElsewhere.push(tty);
      return w.elsewhere;
    },
  };
  return new TmuxInputTarget(
    tmux,
    terminals,
    modes,
    async argv => {
      w.ran.push(argv);
      return w.ps;
    },
    programs,
    proofs,
  );
}

const dev = { kind: 'terminal', key: 'dev' } as const;

async function observed(w: World): Promise<Extract<InputTargetFacts, { kind: 'terminal' }>> {
  const result = await target(w).observe('s1', dev);
  if (!result.ok || result.facts.kind !== 'terminal') throw new Error('expected facts');
  return result.facts;
}

describe('observing a terminal an input request aims at', () => {
  it('should build the facts from tmux, ps and stty and not from anything the agent wrote', async () => {
    const w = world();

    const facts = await observed(w);

    should(facts).deepEqual({
      kind: 'terminal',
      paneProof: { paneId: '%3', pid: 4242, sessionCreated: 1_700_000_000 },
      foreground: { pid: 4300, pgid: 4300, comm: 'sudo', argv: 'sudo -v' },
      echo: 'off',
      cursorRow: 7,
      promptLine: '[sudo] password for kirin:                       ',
      promptLineDigest: digestLine('[sudo] password for kirin:                       '),
      program: 'sudo',
      recognisedConsumer: true,
      trustedProgram: true,
    });
    should(w.askedElsewhere).deepEqual(['/dev/pts/9']);
    should(w.ran).deepEqual([['ps', '-t', 'pts/9', '-o', 'pid=,pgid=,tpgid=,comm=,args=']]);
    should(w.calls[1]).deepEqual(['capture-pane', '-p', '-N', '-S', '7', '-E', '7', '-t', PANE]);
  });

  it('should report a pane with no session creation second and a shell that is not a consumer', async () => {
    const w = world();
    w.proof = '%3|4242|0|';
    w.ps = ' 4242  4242  4242 bash bash -l\n';

    const facts = await observed(w);

    should(facts.paneProof).deepEqual({ paneId: '%3', pid: 4242 });
    should(facts.recognisedConsumer).be.false();
  });

  it('should strip control characters from the prompt line and the argv and keep them whole up to a generous bound', async () => {
    const w = world();
    w.capture = ok(`ok\u001b[31m${'x'.repeat(300)}\n`);
    w.ps = ` 9  9  9 prog ${'a\u0007'.repeat(300)}\n`;

    const facts = await observed(w);

    should(facts.promptLine.length).equal(306);
    should(facts.promptLine.includes('\u001b')).be.false();
    should(facts.foreground.argv.length).equal(300);
    should(facts.foreground.argv.includes('\u0007')).be.false();
  });

  it('should cut raw text only at a generous bound, so the service masks it BEFORE it is shortened', async () => {
    const w = world();
    w.capture = ok(`${'x'.repeat(5_000)}\n`);
    w.ps = ` 9  9  9 prog ${'a'.repeat(5_000)}\n`;

    const facts = await observed(w);

    should(facts.promptLine.length).equal(4_096);
    should(facts.foreground.argv.length).equal(4_096);
  });

  it('should name a program whose name is only control characters with a placeholder', async () => {
    const w = world();
    w.ps = ' 9  9  9 \u0007\u0007 x\n';

    should((await observed(w)).foreground.comm).equal('?');
  });

  it('should read an empty prompt line when the cursor row is blank', async () => {
    const w = world();
    w.capture = ok('');

    const facts = await observed(w);

    should(facts.promptLine).equal('');
    should(facts.promptLineDigest).equal(digestLine(''));
  });

  it('should carry echo unknown through so a secret fails closed', async () => {
    const w = world();
    w.echo = 'unknown';

    should((await observed(w)).echo).equal('unknown');
  });

  it('should be gone, or unsupported, when there is nothing it can prove', async () => {
    const gone = { ok: false, reason: 'target_gone' };
    const missing = world();
    missing.located = false;
    const noTmux = world();
    noTmux.display = failed;
    const dead = world();
    dead.proof = '%3||1|1700000000';
    const badProof = world();
    badProof.proof = 'nonsense';
    const noTty = world();
    noTty.display = ok(`${noTty.proof}\tpts/9\t7\tsudo\n`);
    const noCursor = world();
    noCursor.display = ok(`${noCursor.proof}\t/dev/pts/9\tx\tsudo\n`);
    const noPs = world();
    noPs.ps = undefined;
    const noForeground = world();
    noForeground.ps = ' 4242  4242  9999 bash bash\n garbage\n';
    const noCapture = world();
    noCapture.capture = failed;

    for (const w of [missing, noTmux, dead, badProof, noTty, noCursor, noPs, noForeground, noCapture])
      should(await target(w).observe('s1', dev)).deepEqual(gone);
    should(await target(world()).observe('s1', { kind: 'browser', key: 'app' })).deepEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('should change the digest when any observed fact changes', async () => {
    const base = digestFacts(await observed(world()));
    const pane = world();
    pane.proof = '%4|4242|0|1700000000';
    const pid = world();
    pid.proof = '%3|4243|0|1700000000';
    const program = world();
    program.ps = ' 4300  4300  4300 bash bash\n';
    const echo = world();
    echo.echo = 'on';
    const cursor = world();
    cursor.cursor = 8;
    const line = world();
    line.capture = ok('Password:\n');

    for (const w of [pane, pid, program, echo, cursor, line]) should(digestFacts(await observed(w))).not.equal(base);
  });
});

describe('a code program is every process of the foreground group, or none', () => {
  /** Proves the pids it is given as code programs (a real ssh), and nothing else. */
  const proving = (...proved: number[]) => ({ codeProgram: async (pid: number) => proved.includes(pid) });
  const observe = async (ps: string, programs?: ReturnType<typeof proving>) => {
    const w = world();
    w.ps = ps;
    return await target(w, programs).observe('s1', { kind: 'terminal', key: 'dev' });
  };

  it('should list every member of the foreground group, leader or not, and no other group', () => {
    should(foregroundPids(' 1 1 7 bash -bash\n 7 7 7 ssh ssh host\n 8 7 7 sh sh -c read\n')).eql([7, 8]);
  });

  it('should prove a code program when the only process holding the terminal is a proven ssh', async () => {
    const seen = await observe(' 4242 4242 7 bash -bash\n 7 7 7 ssh ssh bastion\n', proving(7));

    should(seen.ok && seen.codeProgram).equal(true);
  });

  it('should not prove one when ssh leads but another member reads the terminal (LocalCommand, a pipeline)', async () => {
    // Arrange — ssh's LocalCommand: a shell the ferret wrote, in ssh's own foreground group, running read -s.
    const seen = await observe(' 4242 4242 7 bash -bash\n 7 7 7 ssh ssh bastion\n 8 7 7 sh sh -c read\n', proving(7));

    // Assert
    should(seen.ok).be.true();
    should(seen.ok && seen.codeProgram).be.undefined();
  });

  it('should refuse the write of a code when a reader joined the group after the card, with nothing typed', async () => {
    // Arrange — the card saw ssh alone; by the write, the ferret's 'sh -c read' has joined ssh's foreground group.
    const w = world();
    w.ps = ' 4242 4242 7 bash -bash\n 7 7 7 ssh ssh bastion\n';
    const port = target(w, proving(7));
    const seen = await port.observe('s1', { kind: 'terminal', key: 'dev' });
    if (!seen.ok) throw new Error('not seen');
    w.ps = ' 4242 4242 7 bash -bash\n 7 7 7 ssh ssh bastion\n 8 7 7 sh sh -c read\n';

    // Act
    const checked = await port.type('s1', { kind: 'terminal', key: 'dev' }, '481516', true, seen.facts, {
      codeProgram: true,
    });
    const unchecked = await target(w, proving(7)).type(
      's1',
      { kind: 'terminal', key: 'dev' },
      '481516',
      true,
      seen.facts,
    );

    // Assert — refused only where the card relied on the code program; the facts themselves did not change.
    should(checked).equal('target_changed');
    should(w.typed).have.length(1);
    should(unchecked).equal('typed');
  });

  it('should not prove one with no program port wired', async () => {
    const seen = await observe(' 7 7 7 ssh ssh bastion\n');

    should(seen.ok && seen.codeProgram).be.undefined();
  });
});

describe('parsing the foreground of a terminal', () => {
  it('should prefer the group leader and fall back to another member', () => {
    should(parseForeground(' 5 7 7 a x\n 7 7 7 b y\n')?.pid).equal(7);
    should(parseForeground(' 5 7 7 a x\n')?.pid).equal(5);
  });

  it('should find nothing when no process is in the foreground group', () => {
    should(parseForeground('')).be.undefined();
    should(parseForeground(' 5 7 9 a x\n 0 0 0 k x\n')).be.undefined();
  });
});

describe('typing into a terminal an input request aims at', () => {
  const sends = (w: World) => w.calls.filter(call => call[0] === 'if-shell');
  const keysOf = (text: string, ...more: number[]) =>
    [...new TextEncoder().encode(text), ...more].map(b => b.toString(16).padStart(2, '0'));

  it('should write value and Enter as ONE guarded hex send-keys, never as argv text', async () => {
    const w = world();
    const expected = await observed(w);
    w.calls.length = 0;

    const result = await target(w).type('s1', dev, SECRET, true, expected);

    should(result).equal('typed');
    should(sends(w)).have.length(1);
    should(sends(w)[0]?.slice(0, 4)).deepEqual(['if-shell', '-F', '-t', '%3']);
    should(sends(w)[0]?.[5]).equal(['send-keys', '-H', '-t', '%3', ...keysOf(SECRET, 0x0d)].join(' '));
    should(w.typed).deepEqual([['send-keys', '-H', '-t', '%3', ...keysOf(SECRET, 0x0d)]]);
    should(w.calls.flat().filter(arg => arg.includes(SECRET))).deepEqual([]);
    should(w.calls.some(call => call[0] === 'send-keys')).be.false();
  });

  it('should make tmux itself check the pane pid, program name, cursor row and liveness in the writing command', async () => {
    const w = world();
    const expected = await observed(w);
    w.calls.length = 0;

    await target(w).type('s1', dev, SECRET, false, expected);

    const condition = sends(w)[0]?.[4] ?? '';
    for (const part of [
      '#{==:#{pane_pid},4242}',
      '#{==:#{pane_current_command},sudo}',
      '#{==:#{cursor_y},7}',
      '#{==:#{pane_dead},0}',
    ])
      should(condition.includes(part)).be.true();
  });

  it('should write a long value in a single call and no Enter when not submitting', async () => {
    const w = world();
    const expected = await observed(w);
    w.calls.length = 0;

    await target(w).type('s1', dev, 'p'.repeat(1_000), false, expected);

    should(w.typed).have.length(1);
    should(w.typed[0]).have.length(4 + 1_000);
    should(w.typed[0]?.includes('0d')).be.false();
  });

  it('should write nothing when the pane, its process or its creation time changed', async () => {
    const base = world();
    const expected = await observed(base);
    const pane = world();
    pane.proof = '%4|4242|0|1700000000';
    const pid = world();
    pid.proof = '%3|4243|0|1700000000';
    const created = world();
    created.proof = '%3|4242|0|1700000001';

    for (const w of [pane, pid, created]) {
      should(await target(w).type('s1', dev, SECRET, true, expected)).equal('target_changed');
      should(w.typed).deepEqual([]);
    }
  });

  it('should write nothing when the foreground program, echo state or prompt changed after the card', async () => {
    const expected = await observed(world());
    const foreground = world();
    foreground.ps = ' 4400  4400  4400 ssh ssh evil\n';
    const echo = world();
    echo.echo = 'on';
    const prompt = world();
    prompt.capture = ok('Username: \n');

    for (const w of [foreground, echo, prompt]) {
      should(await target(w).type('s1', dev, SECRET, true, expected)).equal('target_changed');
      should(w.typed).deepEqual([]);
    }
  });

  it('should write nothing when the pane is dead, unreadable or the terminal is gone', async () => {
    const expected = await observed(world());
    const dead = world();
    dead.proof = '%3||1|1700000000';
    const unreadable = world();
    unreadable.display = failed;
    const missing = world();
    missing.located = false;

    for (const w of [dead, unreadable, missing]) {
      should(await target(w).type('s1', dev, SECRET, true, expected)).equal('target_gone');
      should(w.typed).deepEqual([]);
    }
  });

  it('should refuse a browser target and browser facts', async () => {
    const w = world();
    const expected = await observed(w);
    const browserFacts = { ...expected, kind: 'browser' } as unknown as InputTargetFacts;

    should(await target(w).type('s1', { kind: 'browser', key: 'a' }, SECRET, true, expected)).equal('target_gone');
    should(await target(w).type('s1', dev, SECRET, true, browserFacts)).equal('target_gone');
  });

  it('should report an uncertain write when the command fails or throws, and never retry', async () => {
    const expected = await observed(world());
    const writeFails = world();
    writeFails.write = failed;
    const throws = world();
    throws.throwOnSend = true;

    should(await target(writeFails).type('s1', dev, SECRET, true, expected)).equal('uncertain');
    should(sends(writeFails)).have.length(1);
    should(await target(throws).type('s1', dev, SECRET, true, expected)).equal('uncertain');
  });
});

describe('the write is guarded by the tmux server comparison (a change DURING the final observation or the write)', () => {
  const finalWrite = (change: (w: World) => void) => (call: readonly string[], w: World) => {
    if (call[0] === 'if-shell') change(w);
  };

  it('should type nothing when the program changes between the final observation and the write', async () => {
    const w = world();
    const expected = await observed(w);
    w.before = finalWrite(live => {
      live.command = 'bash';
    });

    should(await target(w).type('s1', dev, SECRET, true, expected)).equal('target_changed');
    should(w.typed).deepEqual([]);
  });

  it('should type nothing when the cursor moves or the pane dies between the final observation and the write', async () => {
    for (const change of [
      (live: World) => {
        live.cursor = 9;
      },
      (live: World) => {
        live.proof = '%3|4242|1|1700000000';
      },
      (live: World) => {
        live.proof = '%3|9999|0|1700000000';
      },
    ]) {
      const w = world();
      const expected = await observed(w);
      w.before = finalWrite(change);

      should(await target(w).type('s1', dev, SECRET, true, expected)).equal('target_changed');
      should(w.typed).deepEqual([]);
    }
  });

  it('should refuse when the program changes WHILE the final look reads the prompt line', async () => {
    const w = world();
    const expected = await observed(w);
    let looks = 0;
    w.before = (call, live) => {
      if (call[0] !== 'capture-pane') return;
      looks += 1;
      if (looks === 1) live.command = 'ssh';
    };

    should(await target(w).type('s1', dev, SECRET, true, expected)).equal('target_gone');
    should(w.typed).deepEqual([]);
  });

  it('should refuse when the cursor moves WHILE the final look reads the prompt line', async () => {
    const w = world();
    const expected = await observed(w);
    w.before = (call, live) => {
      if (call[0] === 'capture-pane') live.cursor = 8;
    };

    should(await target(w).type('s1', dev, SECRET, true, expected)).equal('target_gone');
    should(w.typed).deepEqual([]);
  });

  it('should refuse a program whose name tmux cannot be asked to compare safely', async () => {
    const w = world();
    w.command = 'a,b}';
    const expected = await observed(w);

    should(await target(w).type('s1', dev, SECRET, true, expected)).equal('target_changed');
    should(w.typed).deepEqual([]);
  });

  it('DECLARED LIMIT: the guard is compare-and-ENQUEUE, so a foreground that becomes ANY command after the predicate still gets the bytes', async () => {
    const w = world();
    const expected = await observed(w);
    let readerOfThePty = '';
    w.afterEnqueue = live => {
      live.command = 'ssh';
      readerOfThePty = live.command;
    };

    const outcome = await target(w).type('s1', dev, SECRET, true, expected);

    should(outcome).equal('typed');
    should(w.queued).have.length(1);
    should(readerOfThePty).equal('ssh');
    // The predicate named sudo; the program that reads the buffered bytes is not sudo.
    should(w.command).not.equal(expected.foreground.comm);
  });

  it('DECLARED LIMIT: echo turning on after the predicate is not caught either', async () => {
    const w = world();
    const expected = await observed(w);
    w.afterEnqueue = live => {
      live.echo = 'on';
    };

    should(await target(w).type('s1', dev, SECRET, true, expected)).equal('typed');
    should(w.echo).equal('on');
    should(w.queued).have.length(1);
  });

  it('should separate the predicate from the delivery: a world that already changed is refused, never queued', async () => {
    const w = world();
    const expected = await observed(w);
    w.before = finalWrite(live => {
      live.command = 'ssh';
    });

    should(await target(w).type('s1', dev, SECRET, true, expected)).equal('target_changed');
    should(w.queued).deepEqual([]);
  });

  it('DECLARED LIMIT: a same-named program that replaces the foreground after ps is not caught', async () => {
    const w = world();
    const expected = await observed(w);
    w.before = (call, live) => {
      if (call[0] === 'if-shell') live.ps = ' 5000  5000  5000 sudo sudo -v\n';
    };

    should(await target(w).type('s1', dev, SECRET, true, expected)).equal('typed');
  });
});

describe('the screen, for a saved login’s echo look', () => {
  it('should capture the screen and the rows above it, wrapped rows joined', async () => {
    const w = world();
    w.capture = ok('Password:\n$ \n');
    should(await target(w).screen('s1', 'dev', ['dev', 't-dev'])).equal('Password:\n$ \n');
    should(w.calls.at(-1)).containDeep(['capture-pane', '-p', '-J', '-N', '-S', '-50']);
  });

  it('should answer nothing for a terminal it cannot find or capture', async () => {
    const gone = world();
    gone.located = false;
    should(await target(gone).screen('s1', 'dev', ['dev', 't-dev'])).be.undefined();
    const failing = world();
    failing.capture = failed;
    should(await target(failing).screen('s1', 'dev', ['dev', 't-dev'])).be.undefined();
  });
});

describe('the screen look is pinned to the terminal typed into', () => {
  it('should say nothing about another terminal opened under the same name', async () => {
    const w = world();
    should(await target(w).screen('s1', 'dev', ['dev', 't-old'])).be.undefined();
    should(w.calls.some(call => call[0] === 'capture-pane')).be.false();
  });
});

describe('the facts the adaptive lock reads from a terminal', () => {
  it('should say the terminal is in line mode and the program is trusted, when the kernel proves it', async () => {
    const w = world();
    w.canonical = true;
    const facts = await observed(w);
    should(facts.canonical).be.true();
    should(facts.trustedProgram).be.true();
  });

  it('should leave out what it cannot tell, and never claim a program it does not trust', async () => {
    const w = world();
    w.proved = { 4300: { name: 'sudo', setuidRoot: false }, 4301: SUDO };
    const quiet = await observed(w);
    should(quiet).not.have.property('canonical');
    should(quiet).not.have.property('trustedProgram');
    w.canonical = false;
    const facts = await observed(w);
    should(facts.canonical).be.false();
    should(facts).not.have.property('trustedProgram');
  });
});

describe('the program a secret card names is proved for every reader of the terminal, never taken from ps', () => {
  /** sudo at its prompt leads the foreground group; the ferret's `sh -c 'read -s X'` is a second member. */
  const SUDO_AND_READER =
    ' 4242  4242  4300 bash -bash\n 4300  4300  4300 sudo sudo -v\n 4301  4300  4300 sh sh -c read\n';

  it('should not trust a shell that renamed itself sudo: unverified, not recognised, not trusted', async () => {
    // Arrange — `printf sudo > /proc/$$/comm; read -s X`: ps says sudo, the kernel proves nothing.
    const w = world();
    w.ps = ' 4242  4242  4300 bash -bash\n 4300  4300  4300 sudo sudo -v\n';
    w.proved = {};
    w.canonical = true;

    // Act
    const facts = await observed(w);

    // Assert — the name is still shown as what the process calls itself, but nothing is claimed for it.
    should(facts.foreground.comm).equal('sudo');
    should(facts).not.have.property('program');
    should(facts.recognisedConsumer).be.false();
    should(facts).not.have.property('trustedProgram');
  });

  it('should not trust a real sudo leader when another member of its group reads the terminal', async () => {
    // Arrange — the leader is a real setuid sudo; the member is a shell the ferret controls.
    const w = world();
    w.ps = SUDO_AND_READER;
    w.proved = { 4300: SUDO };
    w.canonical = true;

    // Act
    const facts = await observed(w);

    // Assert
    should(facts).not.have.property('program');
    should(facts.recognisedConsumer).be.false();
    should(facts).not.have.property('trustedProgram');
  });

  it('should not call a group trusted when a member is proved but does not run setuid root', async () => {
    // Arrange — `sudo -n bash -c 'read -s X'` leaves a root bash, which is never proved; an exe-proved ssh member is
    // proved but is no setuid program, so the group is recognised and still not trusted for the short lock.
    const w = world();
    w.ps = SUDO_AND_READER;
    w.proved = { 4300: SUDO, 4301: { name: 'ssh', setuidRoot: false } };

    // Act
    const facts = await observed(w);

    // Assert
    should(facts.program).equal('sudo');
    should(facts.recognisedConsumer).be.true();
    should(facts).not.have.property('trustedProgram');
  });

  it('should not recognise a group when a proved member is not a program that asks for a secret', async () => {
    const w = world();
    w.ps = SUDO_AND_READER;
    w.proved = { 4300: SUDO, 4301: { name: 'cat', setuidRoot: false } };

    const facts = await observed(w);

    should(facts.program).equal('sudo');
    should(facts.recognisedConsumer).be.false();
    should(facts).not.have.property('trustedProgram');
  });

  for (const [why, elsewhere] of [
    ['a process of another session holds the terminal open (cat /dev/pts/N)', true],
    ['it cannot be told who else holds the terminal', undefined],
  ] as const)
    it(`should prove nothing, not even a code program, when ${why}`, async () => {
      // Arrange — a real sudo alone in its group, and a real ssh for the code check.
      const w = world();
      w.elsewhere = elsewhere;

      // Act
      const facts = await observed(w);
      const coded = await target(w, { codeProgram: async () => true }).observe('s1', dev);

      // Assert
      should(facts).not.have.property('program');
      should(facts.recognisedConsumer).be.false();
      should(facts).not.have.property('trustedProgram');
      should(coded.ok && coded.codeProgram).be.undefined();
    });

  it('should prove nothing when a proof throws, or with no proof port wired', async () => {
    const w = world();
    const throwing = new TmuxInputTarget(
      { execute: async args => (args[0] === 'display-message' ? ok(`${w.proof}\t/dev/pts/9\t7\tsudo\n`) : w.capture) },
      { locate: async () => ({ tmuxSession: SESSION, id: 't-dev' }) },
      { echo: async () => 'off' },
      async () => w.ps,
      undefined,
      {
        prove: async () => await Promise.reject(new Error('EACCES')),
        heldElsewhere: async () => false,
      },
    );
    const bare = new TmuxInputTarget(
      { execute: async args => (args[0] === 'display-message' ? ok(`${w.proof}\t/dev/pts/9\t7\tsudo\n`) : w.capture) },
      { locate: async () => ({ tmuxSession: SESSION, id: 't-dev' }) },
      { echo: async () => 'off' },
      async () => w.ps,
    );

    for (const port of [throwing, bare]) {
      const seen = await port.observe('s1', dev);
      should(seen.ok).be.true();
      if (!seen.ok || seen.facts.kind !== 'terminal') continue;
      should(seen.facts).not.have.property('program');
      should(seen.facts.recognisedConsumer).be.false();
      should(seen.facts).not.have.property('trustedProgram');
    }
  });

  it('should refuse the write when an unproved reader joined the group after the card, with nothing typed', async () => {
    // Arrange — the card saw sudo alone and proved; by the write, the ferret's reader has joined sudo's group.
    const w = world();
    w.ps = ' 4242  4242  4300 bash -bash\n 4300  4300  4300 sudo sudo -v\n';
    const port = target(w);
    const seen = await port.observe('s1', dev);
    if (!seen.ok) throw new Error('not seen');
    w.ps = SUDO_AND_READER;
    w.proved = { 4300: SUDO };

    // Act
    const result = await port.type('s1', dev, SECRET, true, seen.facts);

    // Assert
    should(result).equal('target_changed');
    should(w.typed).be.empty();
  });
});
