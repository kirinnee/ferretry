/** Synthetic 0.145.0 wire records, shared by the cut and Conversation-reader parity tests. */
import { expect, test } from 'bun:test';

export const FORK_INPUTS = ['asked 1', 'asked 2', 'injected 3', 'asked 4'];
export const SOURCE_ID = '019fab95-c49a-7843-b42f-40a6390eefc3';
export const forkRow = (type: string, payload: object) =>
  `${JSON.stringify({ timestamp: '2026-11-27T09:00:00.000Z', type, payload })}\n`;
export const userRow = (text: string, extra: object = {}) =>
  forkRow('response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
    ...extra,
  });
export const assistantRow = (text: string) =>
  forkRow('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
export const nativeTurn = (n: number) =>
  forkRow('event_msg', { type: 'task_started', turn_id: `turn-${n}` }) +
  userRow(`asked ${n}`) +
  forkRow('event_msg', { type: 'user_message', message: `asked ${n}` }) +
  forkRow('turn_context', {
    turn_id: `turn-${n}`,
    cwd: '/work/source',
    workspace_roots: ['/work/source'],
    sandbox_policy: { type: 'workspace-write', writable_roots: ['/work/source/subfolder', '/independent'] },
    permission_profile: {
      type: 'managed',
      file_system: {
        entries: [
          { path: { type: 'path', value: '/work/source/subfolder' }, access: 'write' },
          { path: { type: 'glob_pattern', value: '/work/source/**/*.ts' }, access: 'read' },
          { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
        ],
      },
    },
  }) +
  assistantRow(`said ${n}`) +
  forkRow('event_msg', { type: 'task_complete', turn_id: `turn-${n}` });
export const forkHeader = (marker: string) =>
  forkRow('session_meta', {
    id: SOURCE_ID,
    session_id: SOURCE_ID,
    cli_version: '0.145.0',
    cwd: '/work/source',
    runtime_workspace_roots: [`${marker}/codex-correlation/unreachable`],
  });
export const forkInputs = (marker = '/fixture/f1') =>
  forkHeader(marker) +
  userRow('<environment_context>synthetic context</environment_context>') +
  userRow('<user_instructions>synthetic instructions</user_instructions>') +
  userRow('<user_environment>synthetic environment</user_environment>') +
  forkRow('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'meta' }] }) +
  nativeTurn(1) +
  // A drained queued input is still the canonical response_item; the event is only its duplicate.
  nativeTurn(2) +
  // An injected input need not have a duplicate event_msg or its own native task.
  userRow('injected 3', { is_meta: true }) +
  assistantRow('said injected 3') +
  nativeTurn(4);

/** Conversation supplies its real reader; the harness's cut test consumes the same raw fixture and expected inputs. */
export function forkReaderCases(parser: {
  parse(input: { text: string }): { observedInputs: readonly { text: string }[] };
}): void {
  test('Codex fork fixture: reader inputs include queued/injected messages and exclude preambles and event duplicates', () => {
    expect(parser.parse({ text: forkInputs() }).observedInputs.map(input => input.text)).toEqual(FORK_INPUTS);
  });
}
