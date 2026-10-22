import { describe, it } from 'bun:test';
import should from 'should';
import { canRedraw, chooseProgress, processProgressHost } from '../../../src/adapters/terminal/progress-factory';
import { ProgressAwareIo } from '../../../src/adapters/terminal/progress-io';
import { TtyProgress, type TtyProgressHost } from '../../../src/adapters/terminal/tty-progress';
import {
  formatByteProgress,
  formatClock,
  formatElapsed,
  formatMegabytes,
  type IProgress,
  NO_PROGRESS,
  PlainProgress,
  plainLine,
  stepText,
  withStep,
} from '../../../src/lib/progress/index';
import { RecordingProgress } from './fixtures';

describe('formatting', () => {
  it('reads an elapsed time at the precision that shows movement', () => {
    should(formatElapsed(0)).equal('0.0s');
    should(formatElapsed(3_450)).equal('3.4s');
    should(formatElapsed(42_900)).equal('42s');
    should(formatElapsed(125_000)).equal('2m05s');
    should(formatElapsed(-5)).equal('0.0s');
  });

  it('counts down against a known length and never passes it', () => {
    should(formatClock(23_400, 60)).equal('23s of 60s');
    should(formatClock(90_000, 60)).equal('60s of 60s');
    should(formatClock(3_450, undefined)).equal('3.4s');
  });

  it('joins a label and its detail only when there is one', () => {
    should(stepText('Downloading', '1/2 packages')).equal('Downloading — 1/2 packages');
    should(stepText('Downloading', undefined)).equal('Downloading');
    should(stepText('Downloading', '')).equal('Downloading');
  });

  it('strips escape sequences and control characters from a tool line', () => {
    should(plainLine('\u001b[1;32m==>\u001b[0m Upgrading\r\u0007  ')).equal('==> Upgrading');
  });

  it('reads bytes as megabytes', () => {
    should(formatMegabytes(4_200_000)).equal('4.2');
    should(formatMegabytes(48_400_000)).equal('48');
    should(formatByteProgress(48_000_000, 120_000_000)).equal('48/120 MB');
  });
});

describe('PlainProgress', () => {
  it('writes a line per step, and only says more when a step has something to say', () => {
    const lines: string[] = [];
    const progress = new PlainProgress(line => lines.push(line));
    progress.start('Checking for an update');
    (progress as IProgress).detail('ignored');
    progress.start('Downloading 1.3.0');
    progress.succeed();
    progress.start('Restarting fyd');
    progress.succeed('fyd updated 1.2.3 → 1.3.0 in 42s');
    progress.pause();
    should(lines).deepEqual([
      '- Checking for an update',
      '- Downloading 1.3.0',
      '- Restarting fyd',
      '✔ fyd updated 1.2.3 → 1.3.0 in 42s',
    ]);
  });

  it('says what failed, and nothing for a failure with no step', () => {
    const lines: string[] = [];
    const progress = new PlainProgress(line => lines.push(line));
    progress.fail();
    progress.start('Switching');
    progress.fail();
    progress.start('Again');
    progress.fail('nix broke');
    progress.start('Gone');
    progress.stop();
    progress.fail();
    should(lines).deepEqual(['- Switching', '✖ Switching failed', '- Again', '✖ nix broke', '- Gone']);
  });

  it('contains no escape sequences', () => {
    const lines: string[] = [];
    const progress = new PlainProgress(line => lines.push(line));
    progress.start('A');
    progress.succeed('B');
    should(lines.join('').includes('\u001b')).be.false();
  });
});

describe('withStep', () => {
  it('completes a step that returns and fails one that throws', async () => {
    const progress = new RecordingProgress();
    should(await withStep(progress, 'Work', async () => await Promise.resolve(7))).equal(7);
    await withStep(progress, 'Broken', () => Promise.reject(new Error('no'))).catch(() => undefined);
    should(progress.events).deepEqual(['start Work', 'succeed', 'start Broken', 'fail']);
  });

  it('passes the expected length along', async () => {
    const progress = new RecordingProgress();
    await withStep(progress, 'Measuring', async () => await Promise.resolve(), { expectedSeconds: 60 });
    should(progress.events[0]).equal('start Measuring [60s]');
  });

  it('does nothing visible with NO_PROGRESS', () => {
    NO_PROGRESS.start('x');
    NO_PROGRESS.detail('x');
    NO_PROGRESS.succeed();
    NO_PROGRESS.fail();
    NO_PROGRESS.pause();
    NO_PROGRESS.stop();
  });
});

class FakeHost implements TtyProgressHost {
  written = '';
  time = 0;
  width = 80;
  ticks: (() => void)[] = [];
  interrupts: (() => void)[] = [];
  reraised = 0;
  cancelledTicks = 0;
  releasedInterrupts = 0;

  write(text: string): void {
    this.written += text;
  }

  columns(): number {
    return this.width;
  }

  now(): number {
    return this.time;
  }

  repeat(callback: () => void): () => void {
    this.ticks.push(callback);
    return () => {
      this.cancelledTicks += 1;
    };
  }

  onInterrupt(callback: () => void): () => void {
    this.interrupts.push(callback);
    return () => {
      this.releasedInterrupts += 1;
    };
  }

  reraiseInterrupt(): void {
    this.reraised += 1;
  }
}

const CLEAR = '\r\u001b[2K';

describe('TtyProgress', () => {
  it('draws a spinner frame, the step, its detail and a clock on one line', () => {
    const host = new FakeHost();
    const progress = new TtyProgress(host);
    progress.start('Downloading 1.3.0');
    progress.detail('23/41 packages, 48/120 MB');
    host.time = 3_400;
    host.ticks[0]?.();
    should(host.written).containEql('\u001b[?25l');
    should(host.written).containEql(`${CLEAR}⠋ Downloading 1.3.0 (0.0s)`);
    should(host.written.endsWith(`${CLEAR}⠙ Downloading 1.3.0 — 23/41 packages, 48/120 MB (3.4s)`)).be.true();
  });

  it('leaves a permanent line for each step and shows the cursor when it is done', () => {
    const host = new FakeHost();
    const progress = new TtyProgress(host);
    progress.start('One');
    host.time = 1_000;
    progress.start('Two');
    host.time = 43_000;
    progress.succeed('fyd updated 1.2.3 → 1.3.0 in 43s');
    should(host.written).containEql(`${CLEAR}✔ One (1.0s)\n`);
    should(host.written).containEql(`${CLEAR}✔ fyd updated 1.2.3 → 1.3.0 in 43s (42s)\n`);
    should(host.written.endsWith('\u001b[?25h')).be.true();
    should(host.cancelledTicks).equal(1);
    should(host.releasedInterrupts).equal(1);
  });

  it('marks a failed step', () => {
    const host = new FakeHost();
    const progress = new TtyProgress(host);
    progress.start('Switching');
    progress.fail();
    should(host.written).containEql('✖ Switching (0.0s)\n');
  });

  it('counts down against an expected length', () => {
    const host = new FakeHost();
    const progress = new TtyProgress(host);
    progress.start('Measuring', { expectedSeconds: 60 });
    host.time = 23_000;
    host.ticks[0]?.();
    should(host.written).containEql('Measuring (23s of 60s)');
  });

  it('keeps the line inside the terminal width', () => {
    const host = new FakeHost();
    host.width = 30;
    const progress = new TtyProgress(host);
    progress.start('A very long step name that cannot possibly fit on the line');
    const drawn = host.written.split(CLEAR).at(-1) ?? '';
    should(drawn.length).be.belowOrEqual(30);
    should(drawn).containEql('…');
  });

  it('ignores a detail with no step, a settle with no step, and a second stop', () => {
    const host = new FakeHost();
    const progress = new TtyProgress(host);
    progress.detail('nothing');
    progress.succeed();
    progress.fail();
    progress.stop();
    progress.stop();
    should(host.written).equal('');
  });

  it('lifts the line for a message printed above it, and draws it again on the next tick', () => {
    const host = new FakeHost();
    const progress = new TtyProgress(host);
    progress.start('Step');
    progress.pause();
    progress.pause();
    host.ticks[0]?.();
    should(host.written.split(CLEAR).length).equal(4);
  });

  it('stop abandons the step without a line and shows the cursor', () => {
    const host = new FakeHost();
    const progress = new TtyProgress(host);
    progress.start('Step');
    progress.stop();
    should(host.written.includes('✔')).be.false();
    should(host.written.includes('✖')).be.false();
    should(host.written.endsWith('\u001b[?25h')).be.true();
  });

  it('leaves a clean line on Ctrl-C and re-raises the interrupt', () => {
    const host = new FakeHost();
    const progress = new TtyProgress(host);
    progress.start('Waiting for fyd to serve');
    host.interrupts[0]?.();
    should(host.written).containEql(`${CLEAR}✖ Waiting for fyd to serve — interrupted\n`);
    should(host.written.endsWith('\u001b[?25h')).be.true();
    should(host.reraised).equal(1);
  });

  it('still re-raises when no step was live', () => {
    const host = new FakeHost();
    const progress = new TtyProgress(host);
    progress.start('Step');
    progress.succeed();
    should(host.releasedInterrupts).equal(1);
    progress.start('Next');
    host.interrupts[1]?.();
    should(host.reraised).equal(1);
  });
});

describe('ProgressAwareIo', () => {
  it('lifts the live line before every message and passes the rest through', () => {
    const progress = new RecordingProgress();
    const seen: string[] = [];
    const io = new ProgressAwareIo(
      {
        success: m => seen.push(`success ${m}`),
        report: m => seen.push(`report ${m}`),
        warn: m => seen.push(`warn ${m}`),
        error: m => seen.push(`error ${m}`),
        diagnostic: m => seen.push(`diagnostic ${m}`),
        setExitCode: c => seen.push(`exit ${String(c)}`),
        interactive: () => true,
      },
      progress,
    );
    io.success('a');
    io.report('b');
    io.warn('c');
    io.error('d');
    io.diagnostic('e');
    io.setExitCode(1);
    should(io.interactive()).be.true();
    should(progress.events).deepEqual(['pause', 'pause', 'pause', 'pause', 'pause']);
    should(seen).deepEqual(['success a', 'report b', 'warn c', 'error d', 'diagnostic e', 'exit 1']);
  });
});

describe('choosing progress', () => {
  it('redraws only on a terminal that is not CI and not dumb', () => {
    should(canRedraw({ stderrIsTty: true, environment: {} })).be.true();
    should(canRedraw({ stderrIsTty: false, environment: {} })).be.false();
    should(canRedraw({ stderrIsTty: true, environment: { CI: 'true' } })).be.false();
    should(canRedraw({ stderrIsTty: true, environment: { CI: '1' } })).be.false();
    should(canRedraw({ stderrIsTty: true, environment: { CI: '0' } })).be.true();
    should(canRedraw({ stderrIsTty: true, environment: { CI: 'false' } })).be.true();
    should(canRedraw({ stderrIsTty: true, environment: { CI: '' } })).be.true();
    should(canRedraw({ stderrIsTty: true, environment: { TERM: 'dumb' } })).be.false();
  });

  it('gives a terminal a spinner and everything else plain lines', () => {
    const lines: string[] = [];
    const host = new FakeHost();
    const plain = chooseProgress(
      { stderrIsTty: false, environment: {} },
      line => lines.push(line),
      () => host,
    );
    plain.start('Step');
    should(lines).deepEqual(['- Step']);
    should(host.written).equal('');
    const live = chooseProgress(
      { stderrIsTty: true, environment: {} },
      line => lines.push(line),
      () => host,
    );
    live.start('Step');
    should(host.written).containEql('⠋ Step');
    should(lines.length).equal(1);
    live.stop();
  });
});

describe('the process progress host', () => {
  it('reports a width, a clock, a cancellable timer and a removable interrupt listener', async () => {
    const host = processProgressHost();
    should(host.columns()).be.above(0);
    should(host.now()).be.above(0);
    let ticks = 0;
    const cancel = host.repeat(() => {
      ticks += 1;
    }, 5);
    await new Promise(resolve => setTimeout(resolve, 30));
    cancel();
    const seen = ticks;
    should(seen).be.above(0);
    await new Promise(resolve => setTimeout(resolve, 20));
    should(ticks).equal(seen);
    const before = process.listenerCount('SIGINT');
    const release = host.onInterrupt(() => undefined);
    should(process.listenerCount('SIGINT')).equal(before + 1);
    release();
    should(process.listenerCount('SIGINT')).equal(before);
  });
});
