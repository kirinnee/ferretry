import { describe, it } from 'bun:test';
import type { AgentLessonToolCall, AgentLessonToolResult } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { registerLessonCommands } from '../../../src/lib/lesson/commands';
import { LessonController } from '../../../src/lib/lesson/controller';
import type { ILessonGateway, ILessonOutput } from '../../../src/lib/lesson/ports';

class CapturingOutput implements ILessonOutput {
  readonly lines: string[] = [];
  success(message: string): void {
    this.lines.push(message);
  }
}

class RecordingLessonGateway implements ILessonGateway {
  readonly calls: AgentLessonToolCall[] = [];
  lessons(call: AgentLessonToolCall): Promise<AgentLessonToolResult> {
    this.calls.push(call);
    return Promise.resolve({ summary: 'filed as a new lesson', outcome: 'filed' });
  }
}

function harness() {
  const gateway = new RecordingLessonGateway();
  const out = new CapturingOutput();
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerLessonCommands(program, new LessonController(gateway, out));
  const run = (...argv: string[]) => program.parseAsync(['node', 'fy', ...argv]);
  return { gateway, out, run };
}

describe('fy lesson suggest', () => {
  it('should carry the rule and the required --scope to the daemon call', async () => {
    // Arrange
    const { gateway, run } = harness();

    // Act
    await run('lesson', 'suggest', 'Run bun install inside the target package.', '--scope', 'global');

    // Assert
    should(gateway.calls).eql([
      { tool: 'lessons.suggest', rule: 'Run bun install inside the target package.', scope: 'global' },
    ]);
  });

  it('should refuse without --scope rather than guessing one', async () => {
    // Arrange
    const { run } = harness();

    // Act + Assert
    await should(run('lesson', 'suggest', 'a rule')).be.rejected();
  });

  it('should emit the protocol payload under --json', async () => {
    // Arrange
    const { out, run } = harness();

    // Act
    await run('lesson', 'suggest', 'a rule', '--scope', 'repo', '--json');

    // Assert
    should(JSON.parse(out.lines[0] ?? '')).eql({ summary: 'filed as a new lesson', outcome: 'filed' });
  });
});
