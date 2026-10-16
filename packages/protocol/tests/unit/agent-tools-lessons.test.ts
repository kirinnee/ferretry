import { describe, it } from 'bun:test';
import should from 'should';
import * as lessons from '../../src/lib/agent-tools-lessons.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const call = { tool: 'lessons.suggest', rule: 'Use bun, not Python, for scripts.', scope: 'global' };
const result = { summary: 'Filed a new Global lesson.', proposalId: 'lesson-1', count: 1, outcome: 'filed' };

const cases: SchemaCase[] = [
  { name: 'lesson tool call', schema: lessons.AgentLessonToolCallSchema, value: call },
  { name: 'lesson tool result', schema: lessons.AgentLessonToolResultSchema, value: result },
];

describe('lessons agent tool schemas', () => {
  it('should round-trip every public schema', () => {
    // Arrange + Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(lessons, cases);
  });

  it('should trim the rule and accept both scopes and a previously rejected answer', () => {
    // Arrange
    const repo = { ...call, rule: '  Run nix fmt before committing.  ', scope: 'repo' };

    // Act
    const parsed = lessons.AgentLessonToolCallSchema.parse(repo);
    const rejected = lessons.AgentLessonToolResultSchema.parse({
      summary: 'Already rejected.',
      outcome: 'previously-rejected',
    });

    // Assert
    should(parsed).deepEqual({ ...repo, rule: 'Run nix fmt before committing.' });
    should(rejected.outcome).equal('previously-rejected');
    should(lessons.AGENT_LESSONS_PATH).equal('/v1/agent/lessons');
  });

  it('should refuse an empty, oversized or unscoped rule and an unknown tool', () => {
    // Arrange + Act + Assert
    assertRejects([
      { name: 'blank rule', schema: lessons.AgentLessonToolCallSchema, value: { ...call, rule: '   ' } },
      {
        name: 'rule past the ceiling',
        schema: lessons.AgentLessonToolCallSchema,
        value: { ...call, rule: 'r'.repeat(lessons.LESSON_RULE_MAX_CHARS + 1) },
      },
      { name: 'unknown scope', schema: lessons.AgentLessonToolCallSchema, value: { ...call, scope: 'login' } },
      { name: 'unknown tool', schema: lessons.AgentLessonToolCallSchema, value: { ...call, tool: 'lessons.apply' } },
      { name: 'extra field', schema: lessons.AgentLessonToolCallSchema, value: { ...call, sessionId: 'other' } },
      { name: 'zero count', schema: lessons.AgentLessonToolResultSchema, value: { ...result, count: 0 } },
    ]);
  });
});
