import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AnalyticsTranscriptEvidence,
  foldAnalyticsSessionActivity,
} from '../../../src/lib/analytics/usage-fold.ts';
import {
  ClaudeTranscriptParser,
  CodexTranscriptParser,
  parseTranscriptJsonl,
} from '../../../src/lib/transcript/index.ts';
import type { TranscriptEvent } from '../../../src/lib/transcript/types.ts';

const jsonl = (records: readonly object[]): string => `${records.map(record => JSON.stringify(record)).join('\n')}\n`;

function claude(records: readonly object[]): AnalyticsTranscriptEvidence {
  const parsed = parseTranscriptJsonl(new ClaudeTranscriptParser(), { text: jsonl(records) });
  return {
    kind: 'read',
    harness: 'claude',
    events: parsed.events,
    issues: parsed.issues.map(issue => issue.code),
    pendingBytes: 0,
  };
}

function codex(records: readonly object[]): AnalyticsTranscriptEvidence {
  const parsed = parseTranscriptJsonl(new CodexTranscriptParser(), { text: jsonl(records) });
  return {
    kind: 'read',
    harness: 'codex',
    events: parsed.events,
    issues: parsed.issues.map(issue => issue.code),
    pendingBytes: 0,
  };
}

const at = (time: string) => `2026-10-20T${time}.000Z`;

/** A Claude Code session: a prompt, a tool round trip, an hour's idle wait, a second prompt. */
const CLAUDE_SESSION = [
  { type: 'user', uuid: 'u1', timestamp: at('10:00:00'), message: { role: 'user', content: 'Fix the flaky test' } },
  {
    type: 'assistant',
    uuid: 'a1',
    timestamp: at('10:00:05'),
    message: {
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'bun test' } }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  },
  // A tool result rides the user channel and is NOT a prompt.
  {
    type: 'user',
    uuid: 'u2',
    timestamp: at('10:00:40'),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '1 fail' }] },
  },
  // Nor is a record the harness wrote there itself.
  {
    type: 'user',
    uuid: 'u3',
    isMeta: true,
    timestamp: at('10:01:00'),
    message: { role: 'user', content: 'Background command finished' },
  },
  {
    type: 'assistant',
    uuid: 'a2',
    timestamp: at('10:02:00'),
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Fixed.' }] },
  },
  // An hour later — the wait is not active time.
  {
    type: 'user',
    uuid: 'u4',
    timestamp: at('11:02:00'),
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'Thanks.' },
        { type: 'text', text: 'Now the docs.' },
      ],
    },
  },
  {
    type: 'assistant',
    uuid: 'a3',
    timestamp: at('11:02:30'),
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }] },
  },
];

/** A Codex rollout: injected context, a prompt, a tool call, then a second prompt. */
const CODEX_SESSION = [
  { timestamp: at('09:00:00'), type: 'session_meta', payload: { id: 'rollout-1', cwd: '/work' } },
  {
    timestamp: at('09:00:00'),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<user_instructions>\nBe terse.\n</user_instructions>' }],
    },
  },
  {
    timestamp: at('09:00:01'),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/work</cwd>\n</environment_context>' }],
    },
  },
  { timestamp: at('09:00:10'), type: 'turn_context', payload: { model: 'gpt-6-astra', cwd: '/work' } },
  {
    timestamp: at('09:00:10'),
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List the files' }] },
  },
  { timestamp: at('09:00:10'), type: 'event_msg', payload: { type: 'user_message', message: 'List the files' } },
  {
    timestamp: at('09:00:15'),
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'call_1' },
  },
  {
    timestamp: at('09:00:16'),
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'call_1', output: 'a.ts' },
  },
  {
    timestamp: at('09:00:20'),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2, total_tokens: 7 } },
    },
  },
  {
    timestamp: at('09:00:25'),
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a.ts' }] },
  },
  {
    timestamp: at('09:30:00'),
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Thanks' }] },
  },
  {
    timestamp: at('09:30:04'),
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Welcome' }] },
  },
];

describe('analytics session activity fold', () => {
  it('should time a Claude session turn by turn, leaving out the wait between turns', () => {
    // Act
    const actual = foldAnalyticsSessionActivity(claude(CLAUDE_SESSION));

    // Assert — turn one runs to its last work (10:00:40, the tool result): 40 s. The meta record at
    // 10:01 is harness input: it opens an uncounted segment to its reply at 10:02 (60 s). Turn two is
    // 30 s, and the hour between is idle: 130 s over two turns.
    should(actual).deepEqual({ activeDurationMs: 130_000, turns: 2 });
  });

  it('should time a Codex rollout, skipping the context Codex injects as user messages', () => {
    // Act
    const actual = foldAnalyticsSessionActivity(codex(CODEX_SESSION));

    // Assert — 09:00:10→09:00:25 is 15 s, 09:30:00→09:30:04 is 4 s
    should(actual).deepEqual({ activeDurationMs: 19_000, turns: 2 });
  });

  it('should state nothing for a transcript that shows no prompt at all', () => {
    // Act
    const actual = foldAnalyticsSessionActivity(claude([CLAUDE_SESSION[1]!]));

    // Assert
    should(actual).deepEqual({ activeDurationMs: null, turns: null });
  });

  it('should count the model thinking as work that keeps a turn open', () => {
    // Arrange — the only record after the prompt is a thinking block, so it alone sets the turn's end
    const transcript = [
      CLAUDE_SESSION[0]!,
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: at('10:00:20'),
        message: {
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'thinking', thinking: 'Weighing the options', signature: 'sig' }],
        },
      },
    ];

    // Act
    const actual = foldAnalyticsSessionActivity(claude(transcript));

    // Assert
    should(actual).deepEqual({ activeDurationMs: 20_000, turns: 1 });
  });

  it('should refuse active time when a prompt carries no readable timestamp, and still count turns', () => {
    // Arrange
    const untimed = [{ ...CLAUDE_SESSION[0]!, timestamp: 'not an instant' }, ...CLAUDE_SESSION.slice(1)];

    // Act
    const actual = foldAnalyticsSessionActivity(claude(untimed));

    // Assert
    should(actual).deepEqual({ activeDurationMs: null, turns: 2 });
  });

  it('should never count a turn backwards when its records are out of order', () => {
    // Arrange — a record stamped before its own prompt
    const events: TranscriptEvent[] = [
      { harness: 'claude', role: 'user', kind: 'message', text: 'go', timestamp: at('10:00:10') },
      { harness: 'claude', role: 'assistant', kind: 'message', text: 'early', timestamp: at('10:00:00') },
      { harness: 'claude', role: 'assistant', kind: 'message', text: 'untimed' },
    ];

    // Act
    const actual = foldAnalyticsSessionActivity({
      kind: 'read',
      harness: 'claude',
      events,
      issues: [],
      pendingBytes: 0,
    });

    // Assert
    should(actual).deepEqual({ activeDurationMs: 0, turns: 1 });
  });

  it.each([
    { name: 'an unresolved transcript', evidence: { kind: 'unresolved' } as const },
    { name: 'an unreadable transcript', evidence: { kind: 'unreadable' } as const },
    {
      name: 'a damaged transcript',
      evidence: { kind: 'read', harness: 'claude', events: [], issues: ['invalid-json'], pendingBytes: 0 } as const,
    },
    {
      name: 'a transcript read mid-record',
      evidence: { kind: 'read', harness: 'claude', events: [], issues: [], pendingBytes: 12 } as const,
    },
  ])('should state nothing for $name', ({ evidence }) => {
    // Act
    const actual = foldAnalyticsSessionActivity(evidence);

    // Assert
    should(actual).deepEqual({ activeDurationMs: null, turns: null });
  });
});

describe('analytics session activity fold, on the records real transcripts carry', () => {
  const assistant = (uuid: string, time: string, content: object[], stop?: string) => ({
    type: 'assistant',
    uuid,
    timestamp: at(time),
    message: { id: `msg_${uuid}`, role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop ?? null },
  });
  const user = (uuid: string, time: string, content: unknown, extra: object = {}) => ({
    type: 'user',
    uuid,
    timestamp: at(time),
    message: { role: 'user', content },
    ...extra,
  });

  it('should not stretch a Codex turn over the idle gap that task_started and turn_context open', () => {
    // Arrange — the order a real rollout writes a second turn in: complete, hours idle, started,
    // turn_context, then the prompt.
    const rollout = [
      ...CODEX_SESSION.slice(0, 10),
      { timestamp: at('09:00:26'), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'a.ts' } },
      { timestamp: at('13:00:00'), type: 'event_msg', payload: { type: 'task_started', model_context_window: 1 } },
      { timestamp: at('13:00:00'), type: 'turn_context', payload: { model: 'gpt-6-astra', cwd: '/work' } },
      {
        timestamp: at('13:00:01'),
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Again' }] },
      },
      {
        timestamp: at('13:00:11'),
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
      },
      { timestamp: at('13:00:12'), type: 'event_msg', payload: { type: 'task_complete' } },
    ];

    // Act
    const actual = foldAnalyticsSessionActivity(codex(rollout));

    // Assert — 09:00:10→09:00:26 (16 s) and 13:00:01→13:00:12 (11 s); the four hours are idle
    should(actual).deepEqual({ activeDurationMs: 27_000, turns: 2 });
  });

  it('should count the AGENTS.md injection Codex sends as two blocks of one message as no turn', () => {
    // Arrange — the spelling every current rollout opens with
    const rollout = [
      {
        timestamp: at('09:00:00'),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nBe terse.\n</INSTRUCTIONS>' },
            { type: 'input_text', text: '<environment_context>\n  <cwd>/work</cwd>\n</environment_context>' },
          ],
        },
      },
      ...CODEX_SESSION.slice(4, 10),
    ];

    // Act
    const actual = foldAnalyticsSessionActivity(codex(rollout));

    // Assert
    should(actual).deepEqual({ activeDurationMs: 15_000, turns: 1 });
  });

  it('should close a Claude turn at a task notification and count its reply apart, as no turn', () => {
    // Arrange — the turn ends at 10:00:10; a notification arrives five hours later and is answered
    const transcript = [
      user('u1', '10:00:00', 'Start the build'),
      assistant('a1', '10:00:10', [{ type: 'text', text: 'Started.' }], 'end_turn'),
      user('n1', '15:00:00', '<task-notification>build done</task-notification>', {
        origin: { kind: 'task-notification' },
      }),
      assistant('a2', '15:00:04', [{ type: 'text', text: 'No response requested.' }], 'end_turn'),
    ];

    // Act
    const actual = foldAnalyticsSessionActivity(claude(transcript));

    // Assert — 10 s of turn plus the 4 s reply; never the five hours
    should(actual).deepEqual({ activeDurationMs: 14_000, turns: 1 });
  });

  it('should count no Claude slash command, command output, interrupt or compact summary as a turn', () => {
    // Arrange
    const transcript = [
      user('u1', '10:00:00', 'Refactor the parser'),
      assistant('a1', '10:00:20', [{ type: 'tool_use', id: 't1', name: 'Edit', input: {} }], 'tool_use'),
      user('i1', '10:00:30', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
      user('c1', '10:01:00', '<command-name>/model</command-name>\n<command-message>model</command-message>'),
      user('c2', '10:01:00', '<local-command-stdout>Set model to opus</local-command-stdout>'),
      user('s1', '10:02:00', 'This session is being continued from a previous conversation…', {
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
      assistant('a2', '10:02:30', [{ type: 'text', text: 'Continuing.' }], 'end_turn'),
    ];

    // Act
    const actual = foldAnalyticsSessionActivity(claude(transcript));

    // Assert — one turn (20 s) and the compaction's continuation (30 s); the rest are inputs with no work
    should(actual).deepEqual({ activeDurationMs: 50_000, turns: 1 });
  });

  it('should never count the same time twice when a prompt is stamped before the last work', () => {
    // Arrange — a queued prompt written 2 s before the previous turn's final record
    const transcript = [
      user('u1', '10:00:00', 'One'),
      assistant('a1', '10:00:10', [{ type: 'text', text: 'Working' }]),
      user('u2', '10:00:08', 'Two'),
      assistant('a2', '10:00:20', [{ type: 'text', text: 'Done' }], 'end_turn'),
    ];

    // Act
    const actual = foldAnalyticsSessionActivity(claude(transcript));

    // Assert — 10:00:00→10:00:10 and 10:00:10→10:00:20, not 10 + 12
    should(actual).deepEqual({ activeDurationMs: 20_000, turns: 2 });
  });

  it('should skip input that carries no timestamp without counting anything for it', () => {
    // Arrange
    const events: TranscriptEvent[] = [
      { harness: 'claude', role: 'user', kind: 'message', text: 'go', timestamp: at('10:00:00') },
      { harness: 'claude', role: 'assistant', kind: 'message', text: 'ok', timestamp: at('10:00:05') },
      { harness: 'claude', role: 'user', kind: 'message', text: 'note', inputSource: 'harness' },
      { harness: 'claude', role: 'assistant', kind: 'message', text: 'reply', timestamp: at('12:00:00') },
      { harness: 'claude', role: 'developer', kind: 'message', text: 'context', timestamp: at('13:00:00') },
    ];

    // Act
    const actual = foldAnalyticsSessionActivity({
      kind: 'read',
      harness: 'claude',
      events,
      issues: [],
      pendingBytes: 0,
    });

    // Assert
    should(actual).deepEqual({ activeDurationMs: 5_000, turns: 1 });
  });
});

describe('analytics session activity fold, on records Claude Code writes for itself', () => {
  const record = (type: 'user' | 'assistant', uuid: string, time: string, message: object, extra: object = {}) => ({
    type,
    uuid,
    timestamp: at(time),
    message,
    ...extra,
  });

  it('should never let a <synthetic> assistant record stretch an open turn across idle hours', () => {
    // Arrange — the real shape: a turn that ends on a tool result (no end_turn, so it stays open),
    // then hours later Claude Code's own "No response requested." just before the next prompt.
    const transcript = [
      record('user', 'u1', '10:00:00', { role: 'user', content: 'Run the suite' }),
      record('assistant', 'a1', '10:00:05', {
        id: 'msg_a1',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun test' } }],
        stop_reason: 'tool_use',
      }),
      record('user', 'r1', '10:00:30', {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      }),
      record('assistant', 's1', '20:54:00', {
        id: 'msg_s1',
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'No response requested.' }],
        stop_reason: 'stop_sequence',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
      record('user', 'u2', '20:55:00', { role: 'user', content: 'Next' }),
      record('assistant', 'a2', '20:55:10', {
        id: 'msg_a2',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
      }),
    ];

    // Act
    const evidence = claude(transcript);
    const actual = foldAnalyticsSessionActivity(evidence);
    const synthetic = evidence.kind === 'read' ? evidence.events.find(event => event.recordId === 's1') : undefined;

    // Assert — 30 s and 10 s; never the ten hours before the synthetic record
    should(actual).deepEqual({ activeDurationMs: 40_000, turns: 2 });
    should(synthetic?.inputSource).equal('harness');
  });

  it('should start a turn at a prompt-type slash command, and none at a local built-in', () => {
    // Arrange — /review expands into an isMeta prompt; /model answers locally
    const transcript = [
      record('user', 'c1', '10:00:00', {
        role: 'user',
        content:
          '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>parser</command-args>',
      }),
      record(
        'user',
        'm1',
        '10:00:00',
        { role: 'user', content: [{ type: 'text', text: 'Review the parser…' }] },
        {
          isMeta: true,
        },
      ),
      record('assistant', 'a1', '10:00:40', {
        id: 'msg_a1',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'Reviewed.' }],
        stop_reason: 'end_turn',
      }),
      record('user', 'c2', '10:05:00', {
        role: 'user',
        content: '<command-name>/model</command-name>\n<command-message>model</command-message>',
      }),
      record('user', 'o2', '10:05:00', {
        role: 'user',
        content: '<local-command-stdout>Set model to opus</local-command-stdout>',
      }),
      record('user', 'c3', '10:06:00', { role: 'user', content: '<command-name>/exit</command-name>' }),
    ];

    // Act
    const actual = foldAnalyticsSessionActivity(claude(transcript));

    // Assert — /review is the one turn (40 s); /model is local; a trailing command with no answer is a
    // prompt the model never answered, a zero-length turn
    should(actual).deepEqual({ activeDurationMs: 40_000, turns: 2 });
  });

  it('should read a prompt split by an image block as one prompt', () => {
    // Arrange — text, image, text: three blocks of one record
    const transcript = [
      record('user', 'u1', '10:00:00', {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
          { type: 'text', text: 'and fix it' },
        ],
      }),
      record('assistant', 'a1', '10:00:20', {
        id: 'msg_a1',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'Fixed.' }],
        stop_reason: 'end_turn',
      }),
    ];

    // Act
    const actual = foldAnalyticsSessionActivity(claude(transcript));

    // Assert
    should(actual).deepEqual({ activeDurationMs: 20_000, turns: 1 });
  });
});
