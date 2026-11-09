import { describe, it } from 'bun:test';
import should from 'should';
import { ComposerActs } from '../../../../daemon/adapters/tmux/composer-acts.ts';
import { TmuxController } from '../../../../daemon/lib/tmux/controller.ts';
import { FakeTmuxServer } from '../support/fake-tmux-server.ts';

const SESSION = 'fy-session-1';
const KEYS = { clearMargin: 2, submitPolls: 3, pollMs: 10 };

/** The send path's acts over the composer-modelling tmux the tests own; every sleep moves its virtual clock. */
function acts(server: FakeTmuxServer): ComposerActs {
  return new ComposerActs(
    new TmuxController(server),
    SESSION,
    async milliseconds => server.advance(milliseconds),
    KEYS,
  );
}

describe('ComposerActs', () => {
  describe('observe', () => {
    it('should read an idle, booted pane as ready with nothing running and nothing blocking', async () => {
      // Arrange
      const server = new FakeTmuxServer();

      // Act
      const actual = await acts(server).observe();

      // Assert
      should(actual.alive).equal(true);
      should(actual.dead).equal(false);
      should(actual.activeWork).equal(false);
      should(actual.startupParked).equal(false);
      should(actual.blockingPrompt).be.undefined();
      should(actual.draft).be.undefined();
    });

    it('should say a pane is working while a turn runs', async () => {
      // Arrange
      const server = new FakeTmuxServer();
      server.working = true;

      // Act
      const actual = await acts(server).observe();

      // Assert
      should(actual.activeWork).equal(true);
    });

    it('should say a pane is parked while the harness still holds an accepted message under its startup line', async () => {
      // Arrange
      const server = new FakeTmuxServer();
      server.startupWaitUntilMs = 1000;

      // Act
      const actual = await acts(server).observe();

      // Assert
      should(actual.startupParked).equal(true);
    });

    it('should name a blocking prompt that would take a typed message for an answer', async () => {
      // Arrange
      const server = new FakeTmuxServer();
      server.modal = 'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit';

      // Act
      const actual = await acts(server).observe();

      // Assert
      should(actual.blockingPrompt).not.be.undefined();
    });

    it('should report a draft a person left in the composer', async () => {
      // Arrange
      const server = new FakeTmuxServer();
      server.composer = 'half a thought';

      // Act
      const actual = await acts(server).observe();

      // Assert
      should(actual.draft).not.be.undefined();
    });
  });

  describe('heldAt', () => {
    it('should find a payload typed into the composer', async () => {
      // Arrange
      const server = new FakeTmuxServer();
      server.composer = 'please review the diff';

      // Act
      const actual = await acts(server).heldAt('please review the diff');

      // Assert
      should(actual).equal('composer');
    });

    it('should answer nothing when the pane does not hold the payload', async () => {
      // Arrange
      const server = new FakeTmuxServer();

      // Act
      const actual = await acts(server).heldAt('never typed here at all');

      // Assert
      should(actual).be.undefined();
    });

    it('should throw rather than say "not held" when a queue runs past the top of the pane', async () => {
      // Arrange — the queue's hint is the first row: whatever is queued above it cannot be seen.
      const server = new FakeTmuxServer();
      server.transcript = '  ctrl+x ctrl+s to send now';

      // Act
      const actual = await acts(server)
        .heldAt('a message that was never typed here at all')
        .catch((error: unknown) => error);

      // Assert
      should(actual).be.instanceOf(Error);
      should(String((actual as Error).message)).match(/runs past/);
    });
  });

  describe('clearComposer', () => {
    it('should erase a payload it typed with C-u until the composer is empty', async () => {
      // Arrange
      const server = new FakeTmuxServer();
      server.composer = 'one line payload';

      // Act
      const actual = await acts(server).clearComposer('one line payload');

      // Assert
      should(actual).equal('cleared');
      should(server.composer).equal('');
      should(server.calls.filter(call => call.at(-1) === 'C-u')).have.length(1);
      should(server.calls.some(call => call.at(-1) === 'BSpace')).equal(false);
    });

    it('should keep erasing a multi-line payload while what is left is a start of it, and stop at its bound', async () => {
      // Arrange — the modelled pane drops one line per C-u and then a lone line break it cannot erase further.
      const server = new FakeTmuxServer();
      const payload = 'first line\nsecond line\nthird line';
      server.composer = payload;

      // Act
      const actual = await acts(server).clearComposer(payload);

      // Assert — the payload was erased from its end while it was a prefix, never with BSpace, then given up on.
      should(actual).equal('stuck');
      should(server.composer).equal('first line\nsecond line\n');
      should(server.calls.filter(call => call.at(-1) === 'C-u').length).be.greaterThan(1);
      should(server.calls.some(call => call.at(-1) === 'BSpace')).equal(false);
    });

    it('should say the payload was already absent from an empty composer, sending no key', async () => {
      // Arrange
      const server = new FakeTmuxServer();

      // Act
      const actual = await acts(server).clearComposer('one line payload');

      // Assert
      should(actual).equal('absent');
      should(server.calls.some(call => call[0] === 'send-keys')).equal(false);
    });

    it('should leave a draft a person typed beside it alone', async () => {
      // Arrange
      const server = new FakeTmuxServer();
      server.composer = 'something else entirely';

      // Act
      const actual = await acts(server).clearComposer('one line payload');

      // Assert
      should(actual).equal('foreign');
      should(server.composer).equal('something else entirely');
    });

    it('should leave a composer parked under the harness’s startup line, which holds a message already accepted', async () => {
      // Arrange
      const server = new FakeTmuxServer();
      server.composer = 'one line payload';
      server.startupWaitUntilMs = 1000;

      // Act
      const actual = await acts(server).clearComposer('one line payload');

      // Assert
      should(actual).equal('stuck');
      should(server.calls.some(call => call.at(-1) === 'C-u')).equal(false);
    });

    it('should give up as stuck when the composer will not clear within its bound', async () => {
      // Arrange — a stalled harness reads no key, so the composer never changes.
      const server = new FakeTmuxServer();
      server.composer = 'one line payload';
      server.stalledUntilMs = Number.MAX_SAFE_INTEGER;

      // Act
      const actual = await acts(server).clearComposer('one line payload');

      // Assert
      should(actual).equal('stuck');
      should(server.calls.filter(call => call.at(-1) === 'C-u').length).be.greaterThan(1);
    });

    it('should stop when the composer has no composer to read at all', async () => {
      // Arrange — a modal that replaces the composer.
      const server = new FakeTmuxServer();
      server.modal = 'Allow this edit?\n❯ 1. Yes\n  2. No';
      server.modalReplacesComposer = true;

      // Act
      const actual = await acts(server).clearComposer('one line payload');

      // Assert
      should(actual).equal('stuck');
    });
  });

  describe('submitComposer', () => {
    it('should press Enter once for a composer holding exactly the payload, and report it submitted', async () => {
      // Arrange
      const server = new FakeTmuxServer();
      server.composer = 'ship it';

      // Act
      const actual = await acts(server).submitComposer('ship it');

      // Assert
      should(actual).equal('submitted');
      should(server.submitted).deepEqual(['ship it']);
    });

    it('should press nothing when the composer is empty', async () => {
      // Arrange
      const server = new FakeTmuxServer();

      // Act
      const actual = await acts(server).submitComposer('ship it');

      // Assert
      should(actual).equal('absent');
      should(server.calls.some(call => call.at(-1) === 'Enter')).equal(false);
    });

    it('should press nothing while the pane shows work, a startup wait, a dialog or a dead process', async () => {
      // Arrange
      const working = new FakeTmuxServer();
      working.composer = 'ship it';
      working.working = true;
      const parked = new FakeTmuxServer();
      parked.composer = 'ship it';
      parked.startupWaitUntilMs = 1000;
      const dialog = new FakeTmuxServer();
      dialog.composer = 'ship it';
      dialog.modal = 'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit';
      const dead = new FakeTmuxServer();
      dead.composer = 'ship it';
      dead.dead = true;

      // Act
      const answers = [
        await acts(working).submitComposer('ship it'),
        await acts(parked).submitComposer('ship it'),
        await acts(dialog).submitComposer('ship it'),
        await acts(dead).submitComposer('ship it'),
      ];

      // Assert
      should(answers).deepEqual(['absent', 'absent', 'absent', 'absent']);
    });

    it('should press nothing for a composer that only shows its placeholder', async () => {
      // Arrange
      const server = new FakeTmuxServer();
      server.placeholder = 'Ask Codex to do anything';

      // Act
      const actual = await acts(server).submitComposer('ship it');

      // Assert
      should(actual).equal('absent');
    });

    it('should press nothing for a composer that holds only part of the payload when pressing strictly', async () => {
      // Arrange
      const server = new FakeTmuxServer();
      server.composer = 'ship';

      // Act
      const actual = await acts(server).submitComposer('ship it', true);

      // Assert
      should(actual).equal('absent');
    });

    it('should submit a composer drawn exactly as the payload when pressing strictly', async () => {
      // Arrange
      const server = new FakeTmuxServer();
      server.composer = 'ship it';

      // Act
      const actual = await acts(server).submitComposer('ship it', true);

      // Assert
      should(actual).equal('submitted');
    });

    it('should report holding when the harness never reads the Enter', async () => {
      // Arrange
      const server = new FakeTmuxServer();
      server.composer = 'ship it';
      server.stalledUntilMs = Number.MAX_SAFE_INTEGER;

      // Act
      const actual = await acts(server).submitComposer('ship it');

      // Assert
      should(actual).equal('holding');
      should(server.calls.filter(call => call.at(-1) === 'Enter')).have.length(1);
    });
  });
});
