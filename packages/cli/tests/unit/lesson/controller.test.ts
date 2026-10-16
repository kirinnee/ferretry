import { describe, it } from 'bun:test';
import type { AgentLessonToolCall, AgentLessonToolResult } from '@ferretry/protocol';
import should from 'should';
import { LessonController } from '../../../src/lib/lesson/controller';
import type { ILessonGateway, ILessonOutput } from '../../../src/lib/lesson/ports';

class CapturingOutput implements ILessonOutput {
  readonly lines: string[] = [];
  success(message: string): void {
    this.lines.push(message);
  }
  get text(): string {
    return this.lines.join('\n');
  }
}

/** A fake, not a mock: the controller's decisions are asserted through the call it sent and the text it printed. */
class RecordingLessonGateway implements ILessonGateway {
  readonly calls: AgentLessonToolCall[] = [];
  constructor(private readonly result: AgentLessonToolResult = { summary: 'filed as a new lesson', outcome: 'filed' }) {}
  lessons(call: AgentLessonToolCall): Promise<AgentLessonToolResult> {
    this.calls.push(call);
    return Promise.resolve(this.result);
  }
}

function harness(result?: AgentLessonToolResult) {
  const gateway = new RecordingLessonGateway(result);
  const out = new CapturingOutput();
  return { subject: new LessonController(gateway, out), gateway, out };
}

describe('LessonController', () => {
  it('should file a lesson with the rule and scope typed, and print the daemon’s sentence', async () => {
    // Arrange
    const { subject, gateway, out } = harness({ summary: 'filed as a new lesson', outcome: 'filed' });

    // Act
    await subject.suggest('Run bun install inside the target package.', 'global', {});

    // Assert
    should(gateway.calls).eql([
      { tool: 'lessons.suggest', rule: 'Run bun install inside the target package.', scope: 'global' },
    ]);
    should(out.text).equal('filed as a new lesson');
  });

  it('should pass scope repo through unchanged', async () => {
    // Arrange
    const { subject, gateway } = harness();

    // Act
    await subject.suggest('Never touch the root bun.lock.', 'repo', {});

    // Assert
    should(gateway.calls[0]?.scope).equal('repo');
  });

  it('should refuse a scope the protocol does not define, before asking the daemon', async () => {
    // Arrange
    const { subject, gateway } = harness();

    // Act + Assert
    await should(subject.suggest('a rule', 'project', {})).be.rejectedWith(/scope: /u);
    should(gateway.calls).be.empty();
  });

  it('should refuse a rule over the protocol’s length limit, before asking the daemon', async () => {
    // Arrange
    const { subject, gateway } = harness();

    // Act + Assert
    await should(subject.suggest('x'.repeat(501), 'global', {})).be.rejectedWith(/rule: /u);
    should(gateway.calls).be.empty();
  });

  it('should refuse a blank rule', async () => {
    // Arrange
    const { subject } = harness();

    // Act + Assert
    await should(subject.suggest('   ', 'global', {})).be.rejected();
  });

  it('should emit the protocol payload verbatim under --json', async () => {
    // Arrange
    const { subject, out } = harness({ summary: 'merged into an existing lesson (now 3×)', outcome: 'merged', count: 3 });

    // Act
    await subject.suggest('a rule', 'global', { json: true });

    // Assert
    should(JSON.parse(out.text)).eql({ summary: 'merged into an existing lesson (now 3×)', outcome: 'merged', count: 3 });
  });
});
