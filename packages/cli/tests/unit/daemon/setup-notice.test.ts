import { describe, it } from 'bun:test';
import should from 'should';
import { MachineSetupNotice } from '../../../src/lib/daemon/setup-notice';
import { CapturedOutput } from './fixtures';

/**
 * THE ONE LINE A START ENDS WITH WHEN THIS MACHINE IS NOT SET UP YET — and silence otherwise.
 *
 * Starting a daemon never imports anything, so the person who just started one is told both ways to
 * finish. Nothing else may come of it: no terminal, a machine that is set up, or a daemon that could not
 * say all print nothing, because a start that worked must never read as one that did not.
 */
const notice = (options: { setUp?: boolean; failure?: Error; interactive?: boolean } = {}) => {
  const out = new CapturedOutput();
  let reads = 0;
  const subject = new MachineSetupNotice({
    setUp: async () => {
      reads += 1;
      if (options.failure !== undefined) throw options.failure;
      return options.setUp ?? false;
    },
    out,
    interactive: () => options.interactive ?? true,
    clientName: 'fz',
  });
  return { subject, out, reads: () => reads };
};

describe('MachineSetupNotice', () => {
  it('should say once, at a terminal, that a machine with no runtime is not set up, naming both ways in', async () => {
    // Arrange
    const { subject, out } = notice();

    // Act
    await subject.say();

    // Assert
    should(out.lines).deepEqual([
      "warn: This machine isn't set up yet. Pair a phone (`fz pair`) and finish in the app, or run `fz daemon setup`.",
    ]);
    should(out.exitCode).be.undefined();
  });

  it('should say nothing about a machine that is set up', async () => {
    const { subject, out } = notice({ setUp: true });
    await subject.say();
    should(out.lines).be.empty();
  });

  it('should not even ask when nobody is at the terminal', async () => {
    const { subject, out, reads } = notice({ interactive: false });
    await subject.say();
    should(out.lines).be.empty();
    should(reads()).equal(0);
  });

  it('should stay quiet when the daemon could not say, rather than fail a start that worked', async () => {
    const { subject, out } = notice({ failure: new Error('refused') });
    await subject.say();
    should(out.lines).be.empty();
    should(out.exitCode).be.undefined();
  });
});
