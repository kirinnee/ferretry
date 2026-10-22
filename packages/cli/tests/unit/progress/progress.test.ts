import { describe, it } from 'bun:test';
import should from 'should';
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
