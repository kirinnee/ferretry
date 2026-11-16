import { describe, it } from 'bun:test';
import should from 'should';
import { formatByteProgress, formatElapsed, PlainProgress, plainLine } from '../../../src/lib/update/progress.ts';

describe('how elapsed time and downloads are written', () => {
  it('writes tenths under ten seconds, whole seconds under a minute, then minutes and seconds', () => {
    should(formatElapsed(-5)).equal('0.0s');
    should(formatElapsed(3_460)).equal('3.4s');
    should(formatElapsed(42_900)).equal('42s');
    should(formatElapsed(125_000)).equal('2m05s');
  });

  it('writes a download in megabytes, with a decimal while small', () => {
    should(formatByteProgress(4_800_000, 120_000_000)).equal('4.8/120 MB');
  });

  it('strips escape sequences and control characters from a tool’s line', () => {
    should(plainLine('\u001b[31mred\u001b[0m\ttext\u0007 ')).equal('red text');
  });
});

describe('progress on a terminal that cannot redraw', () => {
  const plain = () => {
    const lines: string[] = [];
    return { lines, progress: new PlainProgress(line => lines.push(line)) };
  };

  it('writes a line when a step begins, and one when it succeeds with words of its own', () => {
    const { lines, progress } = plain();
    progress.start('Download');
    progress.detail();
    progress.succeed();
    progress.start('Install');
    progress.succeed('Installed 1.3.0');
    should(lines).deepEqual(['- Download', '- Install', '✔ Installed 1.3.0']);
  });

  it('writes a failure as the step’s own label or the words given, and nothing when no step is live', () => {
    const { lines, progress } = plain();
    progress.fail();
    progress.start('Download');
    progress.fail();
    progress.start('Install');
    progress.fail('could not install');
    should(lines).deepEqual(['- Download', '✖ Download failed', '- Install', '✖ could not install']);
  });

  it('forgets the live step when stopped, so a later failure has no step to blame, and pausing writes nothing', () => {
    const { lines, progress } = plain();
    progress.start('Download');
    progress.pause();
    progress.stop();
    progress.fail();
    should(lines).deepEqual(['- Download']);
  });
});
