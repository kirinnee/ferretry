import { describe, it } from 'bun:test';
import should from 'should';
import type { AgentLessonToolResult } from '../../../contract/index.ts';
import { LessonsController } from '../../../cli/lib/controller.ts';
import { CapturingOutput, RecordingLessonsGateway } from './fixtures.ts';

function harness(result?: AgentLessonToolResult) {
  const gateway = new RecordingLessonsGateway();
  if (result !== undefined) gateway.suggestion = result;
  const out = new CapturingOutput();
  return { subject: new LessonsController(gateway, out, 'fy'), gateway, out };
}

describe('fy lesson suggest', () => {
  it('should file a lesson with the rule and scope typed, and print the daemon’s sentence', async () => {
    // Arrange
    const { subject, gateway, out } = harness({ summary: 'filed as a new lesson', outcome: 'filed' });

    // Act
    await subject.suggest('Run bun install inside the target package.', 'global', {});

    // Assert
    should(gateway.suggested).eql([{ rule: 'Run bun install inside the target package.', scope: 'global' }]);
    should(out.text).equal('filed as a new lesson');
  });

  it('should pass scope repo through unchanged', async () => {
    // Arrange
    const { subject, gateway } = harness();

    // Act
    await subject.suggest('Never touch the root bun.lock.', 'repo', {});

    // Assert
    should(gateway.suggested[0]?.scope).equal('repo');
  });

  it('should refuse a scope the contract does not define, before asking the daemon', async () => {
    // Arrange
    const { subject, gateway } = harness();

    // Act + Assert
    await should(subject.suggest('a rule', 'project', {})).be.rejectedWith(/scope: /u);
    should(gateway.suggested).be.empty();
  });

  it('should refuse a rule over the contract’s length limit, before asking the daemon', async () => {
    // Arrange
    const { subject, gateway } = harness();

    // Act + Assert
    await should(subject.suggest('x'.repeat(501), 'global', {})).be.rejectedWith(/rule: /u);
    should(gateway.suggested).be.empty();
  });

  it('should refuse a blank rule', async () => {
    // Arrange
    const { subject } = harness();

    // Act + Assert
    await should(subject.suggest('   ', 'global', {})).be.rejected();
  });

  it('should emit the wire payload verbatim under --json', async () => {
    // Arrange
    const { subject, out } = harness({
      summary: 'merged into an existing lesson (now 3×)',
      outcome: 'merged',
      count: 3,
    });

    // Act
    await subject.suggest('a rule', 'global', { json: true });

    // Assert
    should(JSON.parse(out.text)).eql({
      summary: 'merged into an existing lesson (now 3×)',
      outcome: 'merged',
      count: 3,
    });
  });
});
