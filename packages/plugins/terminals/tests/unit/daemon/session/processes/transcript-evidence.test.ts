import { describe, it } from 'bun:test';
import should from 'should';
import {
  NO_TRANSCRIPT_EVIDENCE,
  resultFor,
  type TranscriptEvidence,
  transcriptEvidence,
} from '../../../../src/lib/session/processes/transcript-evidence.ts';
import type { TranscriptEvent, TranscriptJsonValue } from '../../../../src/lib/transcript/types.ts';

/**
 * WHAT THE HARNESS ITSELF RECORDED ABOUT ITS TOOL COMMANDS, read off hand-built conversation events.
 */

const at = (iso: string): string => iso;

const call = (id: string, input: TranscriptJsonValue, name = 'Bash'): TranscriptEvent => ({
  kind: 'tool-call',
  harness: 'claude',
  role: 'assistant',
  call: { id, name, input },
});

const result = (
  callId: string,
  text: string,
  options: { readonly isError?: boolean; readonly timestamp?: string; readonly content?: TranscriptJsonValue } = {},
): TranscriptEvent => ({
  kind: 'tool-result',
  harness: 'claude',
  role: 'tool',
  ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
  result: {
    callId,
    content: options.content ?? text,
    ...(options.content === undefined ? { text } : {}),
    isError: options.isError ?? false,
  },
});

const message = (text: string): TranscriptEvent => ({ kind: 'message', harness: 'claude', role: 'user', text });

const notification = (taskId: string, status: string, summary: string): string =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;

describe('transcriptEvidence', () => {
  it('should read background task ids from "Command running in background with ID: …"', () => {
    // Arrange
    const events = [
      call('c1', { command: 'npm run dev', run_in_background: true }),
      result(
        'c1',
        'Command running in background with ID: bx2k9f1a3. Output is being written to: /tmp/x/tasks/bx2k9f1a3.output',
      ),
      call('c2', { command: 'sleep 99' }),
      result('c2', 'Command running in background with ID: b-7_z'),
    ];

    // Act
    const evidence = transcriptEvidence(events);

    // Assert
    should([...evidence.backgroundTaskIds]).deepEqual(['bx2k9f1a3', 'b-7_z']);
    should(evidence.commandResults).deepEqual([]);
  });

  it('should read a completed task notification as exit 0, in a message or in a tool result', () => {
    // Arrange
    const events = [
      message(notification('a1', 'completed', 'Background command "x" completed (exit code 0)')),
      call('c1', { command: 'tail' }),
      result('c1', `ok\n${notification('a2', 'completed', 'done')}`),
    ];

    // Act
    const evidence = transcriptEvidence(events);

    // Assert
    should(evidence.taskExits.get('a1')).deepEqual({ code: 0, failed: false });
    should(evidence.taskExits.get('a2')).deepEqual({ failed: false });
  });

  it('should read a failed notification, and a stated exit code, as failures', () => {
    // Arrange
    const events = [
      message(notification('f1', 'failed', 'Background command "x" failed with exit code 2')),
      message(notification('f2', 'failed', 'Background command "y" failed (exit code 137)')),
      message(notification('f3', 'completed', 'Background command "z" completed (exit code 3)')),
      message(notification('f4', 'killed', 'Background command "w" was stopped')),
    ];

    // Act
    const evidence = transcriptEvidence(events);

    // Assert
    should(evidence.taskExits.get('f1')).deepEqual({ failed: true });
    should(evidence.taskExits.get('f2')).deepEqual({ code: 137, failed: true });
    should(evidence.taskExits.get('f3')).deepEqual({ code: 3, failed: true });
    should(evidence.taskExits.get('f4')).deepEqual({ failed: true });
  });

  it('should ignore a notification with no task id', () => {
    // Arrange
    const events = [message('<task-notification><status>completed</status></task-notification>')];

    // Act
    const evidence = transcriptEvidence(events);

    // Assert
    should(evidence.taskExits.size).equal(0);
  });

  it('should record a foreground result with its text and exit 0 when it says nothing of failing', () => {
    // Arrange
    const events = [call('c1', { command: 'ls' }), result('c1', 'a\nb', { timestamp: at('2026-10-29T10:00:05.000Z') })];

    // Act
    const evidence = transcriptEvidence(events);

    // Assert
    should(evidence.commandResults).deepEqual([
      { command: 'ls', text: 'a\nb', exit: { code: 0, failed: false }, atMs: Date.parse('2026-10-29T10:00:05.000Z') },
    ]);
  });

  it('should read `Exit code 1` with is_error as a failure with that code', () => {
    // Arrange
    const events = [
      call('c1', { command: 'false' }),
      result('c1', 'Exit code 1\nboom', { isError: true }),
      call('c2', { command: 'exit 3' }),
      result('c2', 'out\nExit code: 3', { isError: false }),
    ];

    // Act
    const evidence = transcriptEvidence(events);

    // Assert
    should(evidence.commandResults.map(entry => entry.exit)).deepEqual([
      { code: 1, failed: true },
      { code: 3, failed: true },
    ]);
  });

  it('should call an error with no stated exit code failed, with no code', () => {
    // Arrange
    const events = [call('c1', { command: 'x' }), result('c1', 'Interrupted', { isError: true })];

    // Act
    const evidence = transcriptEvidence(events);

    // Assert
    should(evidence.commandResults[0]?.exit).deepEqual({ failed: true });
  });

  it('should read the command from Codex’s `["bash","-lc","cmd"]` input, and join any other argv', () => {
    // Arrange
    const events = [
      call('c1', { command: ['bash', '-lc', 'bun test'] }, 'shell'),
      result('c1', 'pass'),
      call('c2', { command: ['ls', '-la', '/tmp'] }, 'local_shell'),
      result('c2', 'total 0'),
      call('c3', { cmd: 'pwd' }, 'exec_command'),
      result('c3', '/work'),
    ];

    // Act
    const evidence = transcriptEvidence(events);

    // Assert
    should(evidence.commandResults.map(entry => entry.command)).deepEqual(['bun test', 'ls -la /tmp', 'pwd']);
  });

  it('should read a result whose text is only in its content blocks', () => {
    // Arrange
    const events = [
      call('c1', { command: 'echo hi' }),
      result('c1', '', {
        content: [
          { type: 'text', text: 'hi' },
          { type: 'text', text: ' there' },
        ],
      }),
    ];

    // Act
    const evidence = transcriptEvidence(events);

    // Assert
    should(evidence.commandResults[0]?.text).equal('hi there');
  });

  it('should ignore other tools, results of calls it never saw, and calls with no usable command', () => {
    // Arrange
    const events = [
      call('r1', { file_path: '/x' }, 'Read'),
      result('r1', 'file text'),
      result('lost', 'orphan'),
      call('c1', {}),
      result('c1', 'empty'),
      call('c2', { command: '   ' }),
      result('c2', 'blank'),
      call('c3', 'not an object'),
      result('c3', 'string input'),
    ];

    // Act
    const evidence = transcriptEvidence(events);

    // Assert
    should(evidence.commandResults).deepEqual([]);
  });

  it('should be empty for no events, equal to the shared empty evidence', () => {
    // Arrange / Act
    const evidence = transcriptEvidence([]);

    // Assert
    should(evidence).deepEqual(NO_TRANSCRIPT_EVIDENCE);
  });
});

describe('resultFor', () => {
  const evidence = (...results: readonly { command: string; atMs?: number; text: string }[]): TranscriptEvidence => ({
    backgroundTaskIds: new Set(),
    taskExits: new Map(),
    commandResults: results.map(entry => ({ ...entry, exit: { code: 0, failed: false } })),
  });

  it('should pick the latest result for the command recorded after the process started', () => {
    // Arrange
    const held = evidence(
      { command: 'make', atMs: 1_000, text: 'old run' },
      { command: 'make', atMs: 5_000, text: 'first new' },
      { command: 'make', atMs: 9_000, text: 'latest' },
      { command: 'other', atMs: 9_500, text: 'not this one' },
    );

    // Act
    const found = resultFor(held, 'make', 4_000);

    // Assert
    should(found?.text).equal('latest');
  });

  it('should refuse a result recorded before the process started, allowing a second of clock skew', () => {
    // Arrange
    const held = evidence({ command: 'make', atMs: 2_000, text: 'earlier run' });

    // Act / Assert
    should(resultFor(held, 'make', 4_000)).be.undefined();
    should(resultFor(held, 'make', 3_000)?.text).equal('earlier run');
  });

  it('should accept an untimed result only when nothing timed exists', () => {
    // Arrange
    const untimedOnly = evidence({ command: 'make', text: 'untimed' });
    const both = evidence({ command: 'make', text: 'untimed' }, { command: 'make', atMs: 5_000, text: 'timed' });
    const staleTimed = evidence({ command: 'make', text: 'untimed' }, { command: 'make', atMs: 1_000, text: 'stale' });

    // Act / Assert
    should(resultFor(untimedOnly, 'make', 4_000)?.text).equal('untimed');
    should(resultFor(both, 'make', 4_000)?.text).equal('timed');
    should(resultFor(staleTimed, 'make', 4_000)?.text).equal('untimed');
  });

  it('should find nothing for a process with no label or a command never recorded', () => {
    // Arrange
    const held = evidence({ command: 'make', atMs: 5_000, text: 'x' });

    // Act / Assert
    should(resultFor(held, undefined, 0)).be.undefined();
    should(resultFor(held, 'ninja', 0)).be.undefined();
  });
});

describe('transcriptEvidence, when a result is not plain text', () => {
  it('should read the text blocks of a structured result and skip every other block', () => {
    // Arrange
    const events = [
      call('c1', { command: 'bun test' }),
      result('c1', '', {
        content: [
          { type: 'text', text: 'Exit code 2\n' },
          { type: 'image', source: 'x' },
          'stray',
          { type: 'text', text: 'boom' },
        ],
        isError: true,
      }),
    ];

    // Act
    const evidence = transcriptEvidence(events);

    // Assert
    should(evidence.commandResults).have.length(1);
    should(evidence.commandResults[0]).have.properties({ text: 'Exit code 2\nboom', exit: { code: 2, failed: true } });
  });

  it('should read a result whose content is neither text nor blocks as empty', () => {
    // Arrange
    const events = [call('c1', { command: 'true' }), result('c1', '', { content: { odd: true } })];

    // Act
    const evidence = transcriptEvidence(events);

    // Assert
    should(evidence.commandResults[0]).have.properties({ text: '', exit: { code: 0, failed: false } });
  });
});
