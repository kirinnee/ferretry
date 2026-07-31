import { describe, it } from 'bun:test';
import should from 'should';
import { membershipCommand, revokeCommand } from '../../../src/lib/task-boards/board-command';
import type { TaskBoardCommand } from '../../../src/lib/task-boards/board-command';
import { type ITaskBoardGateway, TaskBoardController } from '../../../src/lib/task-boards/board-controller';
import { FY_BOARD_CAPABILITY_HEADER } from '../../../src/lib/task-boards/board-credentials';
import { renderTaskBoardResponse, withoutCapabilities } from '../../../src/lib/task-boards/board-redaction';
import type { ITaskOutput } from '../../../src/lib/tasks/ports';

class FakeBoardGateway implements ITaskBoardGateway {
  sentCommand: TaskBoardCommand | undefined;
  sentHeaders: Readonly<Record<string, string>> | undefined;

  constructor(private readonly reply: unknown) {}

  send(command: TaskBoardCommand, headers: Readonly<Record<string, string>>): Promise<unknown> {
    this.sentCommand = command;
    this.sentHeaders = headers;
    return Promise.resolve(this.reply);
  }
}

class CapturedOutput implements ITaskOutput {
  readonly lines: string[] = [];

  success(message: string): void {
    this.lines.push(message);
  }
}

describe('redacting a board response', () => {
  it('should drop any key that names a capability, at any depth', () => {
    // Act
    const actual = withoutCapabilities({
      sessionId: 's-1',
      capability: 'secret',
      boardCapability: 'secret',
      nested: { invitationCapability: 'secret', role: 'worker' },
    });

    // Assert
    should(actual).eql({ sessionId: 's-1', nested: { role: 'worker' } });
  });

  it('should redact inside arrays too', () => {
    // Act
    const actual = withoutCapabilities([{ capability: 'secret', id: 'a' }, 'plain', 7, null]);

    // Assert
    should(actual).eql([{ id: 'a' }, 'plain', 7, null]);
  });

  it('should leave a response with nothing secret untouched', () => {
    // Act
    const actual = withoutCapabilities({ relinquished: true, sessionId: 's-1' });

    // Assert
    should(actual).eql({ relinquished: true, sessionId: 's-1' });
  });

  it('should render redacted JSON a human can read', () => {
    // Act
    const actual = renderTaskBoardResponse({ role: 'worker', capability: 'secret' });

    // Assert
    should(actual).equal('{\n  "role": "worker"\n}');
    should(actual).not.containEql('secret');
  });
});

describe('running a board command', () => {
  it('should attach the proof the command needs and print the redacted answer', async () => {
    // Arrange
    const gateway = new FakeBoardGateway({ sessionId: 's-1', role: 'worker', capability: 'never-print-me' });
    const output = new CapturedOutput();
    const controller = new TaskBoardController(gateway, output, { peer: 'peer-proof' });

    // Act
    await controller.run(membershipCommand());

    // Assert
    should(gateway.sentHeaders).eql({ [FY_BOARD_CAPABILITY_HEADER]: 'peer-proof' });
    should(output.lines[0]).not.containEql('never-print-me');
    should(output.lines[0]).containEql('"role": "worker"');
  });

  it('should refuse before calling the daemon when the proof is missing', async () => {
    // Arrange
    const gateway = new FakeBoardGateway({});
    const controller = new TaskBoardController(gateway, new CapturedOutput(), {});

    // Act
    const failure = controller.run(revokeCommand('s-1', 's-2', { reason: 'x' }));

    // Assert
    await should(failure).be.rejectedWith(/FY_BOARD_ADMIN_CAPABILITY/u);
    should(gateway.sentCommand).be.undefined();
  });
});
