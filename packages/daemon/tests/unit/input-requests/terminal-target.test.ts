import { describe, it } from 'bun:test';
import type { InputTargetFacts } from '@ferretry/protocol';
import should from 'should';
import { digestFacts, digestLine } from '../../../src/lib/input-requests/digest.ts';
import {
  parseForeground,
  type TerminalLocator,
  TmuxInputTarget,
} from '../../../src/lib/input-requests/terminal-target.ts';
import type { TerminalModes } from '../../../src/lib/input-requests/terminal-modes.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../src/lib/tmux/contracts.ts';

const SESSION = 'fy-webterm-Hadi-0a1b2c3d-abc123abc123';
const PANE = `${SESSION}:0.0`;
const SECRET = 'hunter2-UNIQUE';
const PS = ' 4242  4242  4300 bash -bash\n 4300  4300  4300 /usr/bin/sudo sudo -v\n 4301  4300  4300 sudo sudo -v\n';

const ok = (stdout: string): TmuxCommandResult => ({ code: 0, stdout, stderr: '' });
const failed: TmuxCommandResult = { code: 1, stdout: '', stderr: "can't find pane" };

interface World {
  proof: string;
  display: TmuxCommandResult | undefined;
  capture: TmuxCommandResult;
  write: TmuxCommandResult;
  throwOnSend: boolean;
  ps: string | undefined;
  echo: 'off' | 'on' | 'unknown';
  located: boolean;
  calls: (readonly string[])[];
  ran: (readonly string[])[];
}

const world = (): World => ({
  proof: '%3|4242|0|1700000000',
  display: undefined,
  capture: ok('[sudo] password for kirin:                       \n'),
  write: ok(''),
  throwOnSend: false,
  ps: PS,
  echo: 'off',
  located: true,
  calls: [],
  ran: [],
});

function target(w: World): TmuxInputTarget {
  const tmux: TmuxCommandPort = {
    execute: async args => {
      w.calls.push(args);
      if (args[0] === 'display-message')
        return w.display ?? ok(args.at(-1)?.includes('pane_tty') ? `${w.proof}\t/dev/pts/9\t7\n` : `${w.proof}\n`);
      if (args[0] === 'capture-pane') return w.capture;
      if (args[0] === 'send-keys') {
        if (w.throwOnSend) throw new Error('socket closed');
        return w.write;
      }
      return failed;
    },
  };
  const terminals: TerminalLocator = {
    locate: async () => (w.located ? { tmuxSession: SESSION } : undefined),
  };
  const modes: TerminalModes = { echo: async () => w.echo };
  return new TmuxInputTarget(tmux, terminals, modes, async argv => {
    w.ran.push(argv);
    return w.ps;
  });
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
      promptLine: '[sudo] password for kirin:',
      promptLineDigest: digestLine('[sudo] password for kirin:'),
      recognisedConsumer: true,
    });
    should(w.ran).deepEqual([['ps', '-t', 'pts/9', '-o', 'pid=,pgid=,tpgid=,comm=,args=']]);
    should(w.calls[1]).deepEqual(['capture-pane', '-p', '-S', '7', '-E', '7', '-t', PANE]);
  });

  it('should report a pane with no session creation second and a shell that is not a consumer', async () => {
    const w = world();
    w.proof = '%3|4242|0|';
    w.ps = ' 4242  4242  4242 bash bash -l\n';

    const facts = await observed(w);

    should(facts.paneProof).deepEqual({ paneId: '%3', pid: 4242 });
    should(facts.recognisedConsumer).be.false();
  });

  it('should strip control characters from the prompt line and the argv and cut both', async () => {
    const w = world();
    w.capture = ok(`ok\u001b[31m${'x'.repeat(300)}\n`);
    w.ps = ` 9  9  9 prog ${'a\u0007'.repeat(300)}\n`;

    const facts = await observed(w);

    should(facts.promptLine.length).equal(200);
    should(facts.promptLine.includes('\u001b')).be.false();
    should(facts.foreground.argv.length).equal(200);
    should(facts.foreground.argv.includes('\u0007')).be.false();
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
    noTty.display = ok(`${noTty.proof}\tpts/9\t7\n`);
    const noCursor = world();
    noCursor.display = ok(`${noCursor.proof}\t/dev/pts/9\tx\n`);
    const noPs = world();
    noPs.ps = undefined;
    const noForeground = world();
    noForeground.ps = ' 4242  4242  9999 bash bash\n garbage\n';
    const noCapture = world();
    noCapture.capture = failed;

    for (const w of [missing, noTmux, dead, badProof, noTty, noCursor, noPs, noForeground, noCapture])
      should(await target(w).observe('s1', dev)).deepEqual(gone);
    should(await target(world()).observe('s1', { kind: 'browser', key: 'app', selector: '#pw' })).deepEqual({
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
    cursor.display = ok(`${cursor.proof}\t/dev/pts/9\t8\n`);
    const line = world();
    line.capture = ok('Password:\n');

    for (const w of [pane, pid, program, echo, cursor, line]) should(digestFacts(await observed(w))).not.equal(base);
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
  it('should write value and Enter as ONE hex send-keys, never as argv text', async () => {
    const w = world();
    const expected = await observed(w);
    w.calls.length = 0;

    const result = await target(w).type('s1', dev, SECRET, true, expected);

    const bytes = [...new TextEncoder().encode(SECRET), 0x0d].map(b => b.toString(16).padStart(2, '0'));
    const sends = w.calls.filter(call => call[0] === 'send-keys');
    should(result).equal('typed');
    should(sends).deepEqual([['send-keys', '-H', '-t', '%3', ...bytes]]);
    should(w.calls.flat().filter(arg => arg.includes(SECRET))).deepEqual([]);
  });

  it('should write a long value in a single call and no Enter when not submitting', async () => {
    const w = world();
    const expected = await observed(w);
    w.calls.length = 0;

    await target(w).type('s1', dev, 'p'.repeat(1_000), false, expected);

    const sends = w.calls.filter(call => call[0] === 'send-keys');
    should(sends).have.length(1);
    should(sends[0]).have.length(4 + 1_000);
    should(sends[0]?.includes('0d')).be.false();
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
      should(w.calls.some(call => call[0] === 'send-keys')).be.false();
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
      should(w.calls.some(call => call[0] === 'send-keys')).be.false();
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
      should(w.calls.some(call => call[0] === 'send-keys')).be.false();
    }
  });

  it('should refuse a browser target and browser facts', async () => {
    const w = world();
    const expected = await observed(w);
    const browserFacts = { ...expected, kind: 'browser' } as unknown as InputTargetFacts;

    should(await target(w).type('s1', { kind: 'browser', key: 'a', selector: '#x' }, SECRET, true, expected)).equal(
      'target_gone',
    );
    should(await target(w).type('s1', dev, SECRET, true, browserFacts)).equal('target_gone');
  });

  it('should report an uncertain write when the send fails or throws, and never retry', async () => {
    const expected = await observed(world());
    const writeFails = world();
    writeFails.write = failed;
    const throws = world();
    throws.throwOnSend = true;

    should(await target(writeFails).type('s1', dev, SECRET, true, expected)).equal('uncertain');
    should(writeFails.calls.filter(call => call[0] === 'send-keys')).have.length(1);
    should(await target(throws).type('s1', dev, SECRET, true, expected)).equal('uncertain');
  });
});
