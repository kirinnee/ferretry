import { describe, expect, test } from 'bun:test';
import { cutRollout } from '../../daemon/lib/fork.ts';
import {
  assistantRow,
  forkHeader,
  forkInputs,
  forkRow,
  nativeTurn,
  SOURCE_ID,
  userRow,
  FORK_INPUTS,
} from '../../contract/testing/fork-inputs.ts';

const target = {
  id: '11111111-2222-3333-4444-555555555555',
  folder: '/work/fork',
  marker: '/fixture/f1/codex-correlation/unreachable',
};
const cutText = (source: string, turn?: number) => {
  const cut = cutRollout(source, turn === undefined ? undefined : { turn }, target);
  expect(cut.kind).toBe('cut');
  if (cut.kind !== 'cut') throw new Error(cut.reason);
  return cut.text;
};
// The same expected inputs are asserted against Conversation's real reader by forkReaderCases.
const inputs = (text: string) =>
  text
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line))
    .flatMap(record =>
      record.type === 'response_item' && record.payload.role === 'user'
        ? record.payload.content.flatMap((block: { text?: string }) =>
            FORK_INPUTS.includes(block.text ?? '') ? [block.text] : [],
          )
        : [],
    );

describe('Codex fork review regressions', () => {
  test('MUST 1: the reader and cut agree on normal, queued and injected inputs, ignoring preambles and event duplicates', () => {
    const source = forkInputs();
    expect(inputs(source)).toEqual(['asked 1', 'asked 2', 'injected 3', 'asked 4']);
    for (const turn of [1, 2, 3, 4]) {
      const cut = cutText(source, turn);
      expect(inputs(cut)).toEqual(inputs(source).slice(0, turn));
      if (turn === 1) expect(cut).not.toContain('turn-2');
    }
  });

  test('MUST 1: a tool pair straddling an injected input refuses rather than leaking the next prompt or leaving half a call', () => {
    const source =
      forkHeader('/fixture/f1') +
      userRow('asked 1') +
      forkRow('response_item', { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: '{}' }) +
      userRow('injected 2') +
      forkRow('response_item', { type: 'function_call_output', call_id: 'call-1', output: 'synthetic result' }) +
      assistantRow('done');
    expect(cutRollout(source, { turn: 1 }, target)).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/tool call/u),
    });
    expect(cutRollout(source, { turn: 2 }, target).kind).toBe('cut');
  });

  test('MUST 1: a cut inside an unfinished native turn refuses; a completed turn is safe', () => {
    const source =
      forkHeader('/fixture/f1') +
      forkRow('event_msg', { type: 'task_started', turn_id: 't' }) +
      userRow('asked 1') +
      assistantRow('working') +
      userRow('injected 2') +
      assistantRow('done') +
      forkRow('event_msg', { type: 'task_complete', turn_id: 't' });
    expect(cutRollout(source, { turn: 1 }, target)).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/native turn/u),
    });
    expect(cutRollout(source, { turn: 2 }, target).kind).toBe('cut');
  });

  test('MUST 1: native id-only tool pairs stay whole, while completed server-side tool items need no separate output', () => {
    for (const type of ['local_shell_call', 'custom_tool_call', 'tool_call', 'tool_search_call']) {
      const called =
        forkHeader('/fixture/f1') +
        userRow('asked 1') +
        forkRow('response_item', { type, id: 'native-call', name: 'synthetic' });
      const outputType = type === 'tool_search_call' ? 'tool_search_output' : `${type}_output`;
      const source =
        called +
        userRow('injected 2') +
        forkRow('response_item', { type: outputType, id: 'native-call', output: 'synthetic result' });
      expect(cutRollout(source, { turn: 1 }, target)).toMatchObject({
        kind: 'refused',
        reason: expect.stringMatching(/tool call/u),
      });
      expect(cutRollout(source, { turn: 2 }, target).kind).toBe('cut');
    }
    for (const type of ['web_search_call', 'image_generation_call']) {
      const source =
        forkHeader('/fixture/f1') +
        userRow('asked 1') +
        forkRow('response_item', { type, id: 'native-call', status: 'completed', result: 'synthetic' });
      expect(cutRollout(source, { turn: 1 }, target).kind).toBe('cut');
    }
  });

  test('MUST 2: every structured self id and cwd changes, while quoted source ids and paths stay conversation text', () => {
    const quote = `quoted ${SOURCE_ID} /work/source`;
    const source =
      forkHeader('/fixture/f1') +
      nativeTurn(1) +
      forkRow('event_msg', {
        type: 'thread_settings_applied',
        session_id: SOURCE_ID,
        thread_settings: { cwd: '/work/source' },
      }) +
      assistantRow(quote);
    const text = cutText(source, 1);
    const records = text
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(
      records.every(record => record.payload.session_id === undefined || record.payload.session_id === target.id),
    ).toBe(true);
    expect(records[0].payload).toMatchObject({ id: target.id, session_id: target.id, cwd: target.folder });
    expect(records.find(record => record.type === 'turn_context').payload.cwd).toBe(target.folder);
    expect(records.find(record => record.type === 'turn_context').payload.workspace_roots).toEqual([target.folder]);
    expect(records.find(record => record.type === 'turn_context').payload.sandbox_policy.writable_roots).toEqual([
      `${target.folder}/subfolder`,
      '/independent',
    ]);
    expect(
      records
        .find(record => record.type === 'turn_context')
        .payload.permission_profile.file_system.entries.map((entry: { path: { value: unknown } }) => entry.path.value),
    ).toEqual([`${target.folder}/subfolder`, `${target.folder}/**/*.ts`, { kind: 'root' }]);
    expect(records.find(record => record.payload.type === 'thread_settings_applied').payload.thread_settings.cwd).toBe(
      target.folder,
    );
    expect(text).toContain(quote);
  });

  test('MUST 2: an untested older version is refused too', () => {
    expect(cutRollout(forkInputs().replace('0.145.0', '0.100.2'), { turn: 1 }, target)).toMatchObject({
      kind: 'refused',
    });
  });

  test('MUST 5: native subagent calls and stored child ids refuse before copying; a cut before them stays safe', () => {
    for (const name of ['spawn_agent', 'resume_agent', 'send_input', 'wait', 'close_agent']) {
      const source =
        forkHeader('/fixture/f1') +
        nativeTurn(1) +
        userRow('asked 2') +
        forkRow('event_msg', { type: 'user_message', message: 'asked 2' }) +
        forkRow('response_item', {
          type: 'function_call',
          name,
          call_id: 'child-call',
          arguments: '{"id":"child-id"}',
        }) +
        forkRow('response_item', {
          type: 'function_call_output',
          call_id: 'child-call',
          output: '{"agent_id":"child-id"}',
        });
      expect(cutRollout(source, { turn: 2 }, target)).toMatchObject({
        kind: 'refused',
        reason: expect.stringMatching(/subagent/u),
      });
      expect(cutRollout(source, { turn: 1 }, target).kind).toBe('cut');
    }
    const source =
      forkHeader('/fixture/f1') +
      nativeTurn(1) +
      forkRow('event_msg', { type: 'collab_agent_spawn_end', new_thread_id: 'child-id' });
    expect(cutRollout(source, undefined, target)).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/subagent/u),
    });
    const compacted =
      forkHeader('/fixture/f1') +
      nativeTurn(1) +
      forkRow('compacted', {
        message: 'synthetic summary',
        replacement_history: [{ type: 'function_call', name: 'spawn_agent', arguments: '{}' }],
      });
    expect(cutRollout(compacted, undefined, target)).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/subagent/u),
    });
  });
});
