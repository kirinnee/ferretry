import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerPinCommands } from '../../../src/lib/pins/commands';
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

function run(argv: string[]): {
  parsed: Promise<unknown>;
  gateway: RecordingPinGateway;
  out: CapturingOutput;
} {
  const gateway = new RecordingPinGateway(board);
  const out = new CapturingOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerPinCommands(program, new PinController(gateway, out, SESSION));
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, out };
}

describe('pin command surface', () => {
  it('should treat a bare note as an add so an agent needs no verb', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['pin', 'remember', 'to', 'rebase']);
    await parsed;

    // Assert
    should(gateway.applied).deepEqual([
      { sessionId: SESSION, request: { action: 'add', kind: 'note', text: 'remember to rebase' } },
    ]);
  });

  it('should accept the explicit add verb', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['pin', 'add', 'explicit', 'note']);
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'add', kind: 'note', text: 'explicit note' });
  });

  it('should list the board on ls', async () => {
    // Arrange + Act
    const { parsed, gateway, out } = run(['pin', 'ls']);
    await parsed;

    // Assert
    should(gateway.listed).deepEqual([SESSION]);
    should(out.messages[0]).startWith(`2 pins in ${SESSION}`);
  });

  it('should accept list as an alias of ls', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['pin', 'list']);
    await parsed;

    // Assert
    should(gateway.listed).deepEqual([SESSION]);
  });

  it('should remove by the short id the listing prints', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['pin', 'rm', '11111111']);
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'remove', id: NOTE_ID });
  });

  it('should accept remove as an alias of rm', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['pin', 'remove', '22222222']);
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'remove', id: MESSAGE_ID });
  });

  it('should edit a note pin', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['pin', 'edit', '11111111', 'a', 'new', 'note']);
    await parsed;

    // Assert
    should(gateway.applied[0]?.request).deepEqual({ action: 'edit', id: NOTE_ID, text: 'a new note' });
  });

  it('should honour --session on the subcommand', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['pin', 'ls', '--session', 'elsewhere']);
    await parsed;

    // Assert
    should(gateway.listed).deepEqual(['elsewhere']);
  });

  it('should honour --session placed on the group', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['pin', '--session', 'elsewhere', 'ls']);
    await parsed;

    // Assert
    should(gateway.listed).deepEqual(['elsewhere']);
  });

  it('should honour --json on the subcommand', async () => {
    // Arrange + Act
    const { parsed, out } = run(['pin', 'ls', '--json']);
    await parsed;

    // Assert
    should(JSON.parse(String(out.messages[0])).pins).have.length(2);
  });

  it('should surface a controller failure as a rejection the composition root can report', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['pin', 'rm', 'deadbeef']);

    // Assert
    await should(parsed).be.rejectedWith(/no pin matches/u);
    should(gateway.applied).be.empty();
  });

  it('should reject rm without an id', async () => {
    // Arrange + Act
    const { parsed } = run(['pin', 'rm']);

    // Assert
    await should(parsed).be.rejected();
  });
});
