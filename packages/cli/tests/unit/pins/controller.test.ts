import { describe, it } from 'bun:test';
import { MAX_PIN_NOTE_LENGTH } from '@ferretry/protocol';
import should from 'should';
import { PinController } from '../../../src/lib/pins/controller';
import {
  CapturingOutput,
  MESSAGE_ID,
  NOTE_ID,
  RecordingPinGateway,
  SESSION,
  humanMessage,
  humanNote,
  snapshot,
} from './fixtures';

const board = snapshot([humanNote(NOTE_ID, 'rebase first'), humanMessage(MESSAGE_ID, 'green')]);

function build(ownSessionId: string | undefined, result = board) {
  const gateway = new RecordingPinGateway(board, result);
  const out = new CapturingOutput();
  return { gateway, out, controller: new PinController(gateway, out, ownSessionId) };
}

describe('pin controller targeting', () => {
  it('should default to the session the command runs inside', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act
    await controller.list({});

    // Assert
    should(gateway.listed).deepEqual([SESSION]);
  });

  it('should let --session target another board', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act
    await controller.list({ session: '  other-session  ' });

    // Assert
    should(gateway.listed).deepEqual(['other-session']);
  });

  it('should refuse to guess when no session is known', async () => {
    // Arrange
    const { controller } = build(undefined);

    // Act + Assert
    await should(controller.list({})).be.rejectedWith(/no session id/u);
  });

  it('should treat a blank session id as absent', async () => {
    // Arrange
    const { controller } = build('   ');

    // Act + Assert
    await should(controller.list({ session: '  ' })).be.rejectedWith(/no session id/u);
  });
});

describe('pin controller output', () => {
  it('should render the human listing by default', async () => {
    // Arrange
    const { controller, out } = build(SESSION);

    // Act
    await controller.list({});

    // Assert
    should(out.messages).have.length(1);
    should(out.messages[0]).startWith(`2 pins in ${SESSION}`);
  });

  it('should emit the protocol snapshot under --json', async () => {
    // Arrange
    const { controller, out } = build(SESSION);

    // Act
    await controller.list({ json: true });

    // Assert
    should(JSON.parse(String(out.messages[0]))).deepEqual(JSON.parse(JSON.stringify(board)));
  });
});

describe('pin controller add', () => {
  it('should join variadic words into one note', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act
    await controller.add(['rebase', 'before', 'pushing'], {});

    // Assert
    should(gateway.applied).deepEqual([
      { sessionId: SESSION, request: { action: 'add', kind: 'note', text: 'rebase before pushing' } },
    ]);
  });

  it('should confirm the add with the resulting board size', async () => {
    // Arrange
    const { controller, out } = build(SESSION);

    // Act
    await controller.add(['something'], {});

    // Assert
    should(out.messages[0]).equal(`pinned — 2 pins in ${SESSION}`);
  });

  it('should refuse an empty note', async () => {
    // Arrange
    const { controller } = build(SESSION);

    // Act + Assert
    await should(controller.add(['   ', ''], {})).be.rejectedWith(/nothing to pin/u);
  });

  it('should refuse a note longer than the protocol allows, naming the limit', async () => {
    // Arrange
    const { controller } = build(SESSION);
    const tooLong = 'z'.repeat(MAX_PIN_NOTE_LENGTH + 1);

    // Act + Assert
    await should(controller.add([tooLong], {})).be.rejectedWith(
      new RegExp(`may not exceed ${MAX_PIN_NOTE_LENGTH} characters \\(got ${MAX_PIN_NOTE_LENGTH + 1}\\)`, 'u'),
    );
  });
});

describe('pin controller edit', () => {
  it('should resolve the short id then send the edit', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act
    await controller.edit('11111111', ['a', 'better', 'note'], {});

    // Assert
    should(gateway.listed).deepEqual([SESSION]);
    should(gateway.applied).deepEqual([
      { sessionId: SESSION, request: { action: 'edit', id: NOTE_ID, text: 'a better note' } },
    ]);
  });

  it('should confirm the edit naming the pin', async () => {
    // Arrange
    const { controller, out } = build(SESSION);

    // Act
    await controller.edit(NOTE_ID, ['changed'], {});

    // Assert
    should(out.messages[0]).equal(`edited 11111111 — 2 pins in ${SESSION}`);
  });

  it('should refuse to edit a message pin instead of sending a doomed request', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act + Assert
    await should(controller.edit('22222222', ['nope'], {})).be.rejectedWith(/is a message pin/u);
    should(gateway.applied).be.empty();
  });

  it('should validate the replacement text before reading the board', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act + Assert
    await should(controller.edit(NOTE_ID, [''], {})).be.rejectedWith(/nothing to pin/u);
    should(gateway.listed).be.empty();
  });
});

describe('pin controller remove', () => {
  it('should resolve the short id then send the removal', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION, snapshot([humanMessage(MESSAGE_ID, 'green')]));

    // Act
    await controller.remove('11111111', {});

    // Assert
    should(gateway.applied).deepEqual([{ sessionId: SESSION, request: { action: 'remove', id: NOTE_ID } }]);
  });

  it('should confirm the removal with the resulting board size', async () => {
    // Arrange
    const { controller, out } = build(SESSION, snapshot([humanMessage(MESSAGE_ID, 'green')]));

    // Act
    await controller.remove(NOTE_ID, {});

    // Assert
    should(out.messages[0]).equal(`removed 11111111 — 1 pin in ${SESSION}`);
  });

  it('should remove a message pin as readily as a note', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act
    await controller.remove('22222222', {});

    // Assert
    should(gateway.applied).deepEqual([{ sessionId: SESSION, request: { action: 'remove', id: MESSAGE_ID } }]);
  });

  it('should report an unknown id without calling the daemon', async () => {
    // Arrange
    const { controller, gateway } = build(SESSION);

    // Act + Assert
    await should(controller.remove('deadbeef', {})).be.rejectedWith(/no pin matches/u);
    should(gateway.applied).be.empty();
  });
});
