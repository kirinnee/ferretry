import { describe, it } from 'bun:test';
import should from 'should';
import { joinOpenTools, summarizeToolInput } from '../../../src/lib/migrate/tool-inventory.ts';

describe('migration tool inventory', () => {
  it('should join a Bash tool to its full command and interruption verdict', () => {
    // Act
    const actual = joinOpenTools(
      ['tool-1'],
      [
        {
          type: 'tool.use',
          timestamp: '2026-07-31T00:00:00.000Z',
          data: { toolUseId: 'tool-1', name: 'Bash', input: { command: 'git push' } },
        },
      ],
    );

    // Assert
    should(actual).deepEqual([
      {
        toolUseId: 'tool-1',
        name: 'Bash',
        summary: 'git push',
        startedAt: '2026-07-31T00:00:00.000Z',
        verdict: 'destructive_to_interrupt',
      },
    ]);
  });

  it('should classify named tools and fail closed when a transcript record is missing', () => {
    // Act
    const actual = joinOpenTools(
      ['read', 'missing'],
      [{ type: 'tool.use', data: { toolUseId: 'read', name: 'Read', input: { file_path: '/work/a.ts' } } }],
    );

    // Assert
    should(actual).deepEqual([
      { toolUseId: 'read', name: 'Read', summary: '/work/a.ts', startedAt: undefined, verdict: 'safe_to_kill' },
      {
        toolUseId: 'missing',
        name: '?',
        summary: '(command not found in chat tail)',
        startedAt: undefined,
        verdict: 'unknown',
      },
    ]);
  });

  it("should join the daemon's own normalized transcript events, which is where the tail now comes from", () => {
    // Arrange: exactly what `TranscriptSource.read` produces for a session that records provenance.
    const events = [
      {
        kind: 'tool-call',
        harness: 'claude',
        role: 'assistant',
        timestamp: '2026-08-01T00:00:00.000Z',
        call: { id: 'tool-1', name: 'Bash', input: { command: 'rm -rf build' } },
      },
      { kind: 'message', harness: 'claude', role: 'assistant', text: 'working' },
    ];

    // Act
    const actual = joinOpenTools(['tool-1'], events);

    // Assert
    should(actual).deepEqual([
      {
        toolUseId: 'tool-1',
        name: 'Bash',
        summary: 'rm -rf build',
        startedAt: '2026-08-01T00:00:00.000Z',
        verdict: 'destructive_to_interrupt',
      },
    ]);
  });

  it('should ignore records of either shape that name no tool call', () => {
    // Arrange: a malformed record must leave the tool unknown rather than join to a partial row.
    const records = [
      null,
      'not a record',
      { type: 'tool.use' },
      { type: 'tool.use', data: { name: 'Bash' } },
      { kind: 'tool-call' },
      { kind: 'tool-call', call: { name: 'Bash' } },
    ];

    // Act
    const actual = joinOpenTools(['tool-1'], records);

    // Assert
    should(actual.map(tool => tool.verdict)).deepEqual(['unknown']);
  });

  it('should summarize common input fields and opaque values safely', () => {
    // Act + Assert
    should(summarizeToolInput('Grep', { path: '/work' })).equal('/work');
    should(summarizeToolInput('Grep', { pattern: 'TODO' })).equal('TODO');
    should(summarizeToolInput('Other', null)).equal('Other');
    should(summarizeToolInput('Other', { enabled: true })).equal('{"enabled":true}');
    const circular: { self?: unknown } = {};
    circular.self = circular;
    should(summarizeToolInput('Other', circular)).equal('(uninspectable input)');
  });
});
