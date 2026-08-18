import { describe, it } from 'bun:test';
import should from 'should';
import { FirstPasswordOffer } from '../../../src/lib/daemon/first-password';
import { CapturedOutput } from './fixtures';

/**
 * ASKING FOR THE FIRST OPERATOR PASSWORD WHEN — AND ONLY WHEN — SOMEBODY IS THERE TO ANSWER.
 *
 * The property this file exists for is a negative one: a start must never be blocked by this. The
 * daemon is launched by systemd and launchd at login with no terminal and nobody watching, and a
 * question asked there would hang the unit until its timeout and silently stop the machine running the
 * daemon at boot. Every failure below is therefore a warning beside a daemon that is already serving.
 */

/** The daemon's answers, and a record of what was actually stored. */
class FakeGateway {
  readonly stored: string[] = [];
  reads = 0;

  constructor(
    private readonly present: boolean,
    private readonly readFailure?: Error,
    private readonly writeFailure?: Error,
  ) {}

  async passwordSet(): Promise<boolean> {
    this.reads += 1;
    if (this.readFailure !== undefined) throw this.readFailure;
    return this.present;
  }

  async setPassword(password: string): Promise<void> {
    if (this.writeFailure !== undefined) throw this.writeFailure;
    this.stored.push(password);
  }
}

/** Scripted answers, in order, and a record of the questions that were asked. */
class ScriptedPrompt {
  readonly asked: string[] = [];

  constructor(private readonly answers: string[]) {}

  async askSecret(message: string): Promise<string> {
    this.asked.push(message);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error('nothing scripted for this question');
    return answer;
  }
}

function subject(options: {
  readonly present?: boolean;
  readonly interactive?: boolean;
  readonly answers?: string[];
  readonly readFailure?: Error;
  readonly writeFailure?: Error;
}) {
  const gateway = new FakeGateway(options.present ?? false, options.readFailure, options.writeFailure);
  const prompt = new ScriptedPrompt(options.answers ?? []);
  const out = new CapturedOutput();
  const offer = new FirstPasswordOffer({
    passwords: gateway,
    prompt,
    out,
    interactive: () => options.interactive ?? true,
    clientName: 'fy',
  });
  return { gateway, prompt, out, offer };
}

describe('the first operator password offer', () => {
  it('should ask NOTHING on a non-interactive start, which is how a service manager reaches it', async () => {
    // THE ONE PROPERTY THAT CANNOT REGRESS. A prompt here hangs a unit start, and a hung unit start
    // means the machine stops running the daemon at login — worse than the requirement it serves. It
    // does not even ask the daemon whether a password exists: there is nobody to tell.
    // Arrange
    const { offer, gateway, prompt, out } = subject({ interactive: false });

    // Act
    await offer.offer();

    // Assert
    should(prompt.asked).be.empty();
    should(gateway.reads).equal(0);
    should(out.lines).be.empty();
  });

  it('should say nothing at all when this machine already has a password', async () => {
    // Every later start is silent. A line saying "you already have one" is a line an operator reads on
    // every boot for the rest of the machine's life.
    // Arrange
    const { offer, prompt, out } = subject({ present: true });

    // Act
    await offer.offer();

    // Assert
    should(prompt.asked).be.empty();
    should(out.lines).be.empty();
  });

  it('should explain before it asks, then store what was typed twice', async () => {
    // Arrange
    const { offer, gateway, prompt, out } = subject({ answers: ['correct horse', 'correct horse'] });

    // Act
    await offer.offer();

    // Assert — the reason comes first, and the confirmation is a second question rather than an echo.
    should(out.lines[0]).match(/^warn: this machine has no operator password/u);
    should(out.lines[0]).match(/not your computer's login/u);
    should(out.lines[0]).match(/no password at all/u);
    should(prompt.asked).have.length(2);
    should(gateway.stored).deepEqual(['correct horse']);
    should(out.lines[1]).match(/^ok: operator password set/u);
  });

  it('should treat an empty answer as a deliberate skip and name the way back', async () => {
    // SKIPPING IS A REAL ANSWER. Local use of a passwordless machine is exactly the state a new install
    // starts in, and the only thing skipping costs is pairing — which says so itself, at the moment
    // somebody tries, with the same remedy.
    // Arrange
    const { offer, gateway, prompt, out } = subject({ answers: ['   '] });

    // Act
    await offer.offer();

    // Assert
    should(prompt.asked).have.length(1);
    should(gateway.stored).be.empty();
    should(out.text).match(/no password set — nothing about using this machine changes/u);
    should(out.text).match(/fy daemon password set/u);
  });

  it('should refuse a too-short password before asking for it a second time', async () => {
    // Asked once, not twice: making somebody confirm a value that is already going to be refused is
    // friction for nothing, and the rule comes from the protocol's own schema rather than a number
    // spelled here.
    // Arrange
    const { offer, gateway, prompt, out } = subject({ answers: ['short'] });

    // Act
    await offer.offer();

    // Assert
    should(prompt.asked).have.length(1);
    should(gateway.stored).be.empty();
    should(out.text).match(/shorter than 8 characters, so nothing was set/u);
    should(out.text).match(/fy daemon password set/u);
  });

  it('should store nothing when the two entries disagree', async () => {
    // A typo stored as the password is the one outcome nobody can recover from without the escape hatch,
    // so it is caught here rather than discovered at the next unlock.
    // Arrange
    const { offer, gateway, out } = subject({ answers: ['correct horse', 'correct hordes'] });

    // Act
    await offer.offer();

    // Assert
    should(gateway.stored).be.empty();
    should(out.text).match(/the two entries did not match, so nothing was set/u);
  });

  it('should warn rather than fail when the daemon cannot say whether a password exists', async () => {
    // FAILING CLOSED HERE MEANS ASKING NOTHING, and that is the safe direction for this surface: it can
    // only ever ADD a password, so the cost of staying quiet is a missed offer. Pairing refuses on its
    // own account, so the guarantee does not depend on this answer arriving.
    // Arrange
    const { offer, prompt, out } = subject({ readFailure: new Error('fyd did not answer /v1/grants') });

    // Act
    await offer.offer();

    // Assert
    should(prompt.asked).be.empty();
    should(out.text).match(/^warn: fy could not ask the daemon/u);
    should(out.text).match(/fyd did not answer \/v1\/grants/u);
    should(out.text).match(/fy daemon password set/u);
  });

  it('should report a failed write as a warning beside a daemon that is already up', async () => {
    // The start SUCCEEDED. Turning a failed password write into a failed `start` would report a daemon
    // that is serving as one that is down, and send an operator looking for the wrong fault.
    // Arrange
    const { offer, out } = subject({
      answers: ['correct horse', 'correct horse'],
      writeFailure: new Error('fyd returned HTTP 403'),
    });

    // Act
    await offer.offer();

    // Assert
    should(out.text).match(/the operator password was not set: fyd returned HTTP 403/u);
    should(out.text).match(/The daemon is running/u);
    should(out.text).not.match(/^ok:/u);
  });
});
