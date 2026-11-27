import { describe, expect, test } from 'bun:test';
import { cutRollout } from '../../daemon/lib/fork.ts';
import {
  assistantRow,
  forkHeader,
  forkRow,
  nativeTurn,
  SOURCE_ID,
  userRow,
} from '../../contract/testing/fork-inputs.ts';

const target = {
  id: '11111111-2222-3333-4444-555555555555',
  folder: '/work/fork',
  marker: '/fixture/correlation/unreachable',
};
const cut = (source: string) => cutRollout(source, { turn: 1 }, target);

describe('round-two native setup and identities', () => {
  test('R1: invocation settings before task_started belong to the next input, including a second settings event and world delta', () => {
    for (const count of [1, 2]) {
      const first = forkHeader('/fixture') + nativeTurn(1);
      const second =
        Array.from({ length: count }, () =>
          forkRow('event_msg', {
            type: 'thread_settings_applied',
            thread_settings: { model: 'next-model', cwd: '/work/source' },
          }),
        ).join('') +
        forkRow('event_msg', { type: 'task_started', turn_id: 'next' }) +
        forkRow('world_state', { full: false, state: { model: 'next-model' } }) +
        forkRow('turn_context', { cwd: '/work/source' }) +
        userRow('asked 2') +
        forkRow('event_msg', { type: 'task_complete', turn_id: 'next' });
      const result = cut(first + second);
      expect(result.kind).toBe('cut');
      if (result.kind !== 'cut') throw new Error(result.reason);
      expect(result.text).not.toContain('next-model');
      expect(result.text).not.toContain('asked 2');
      expect(result.text).toContain('said 1');
    }
  });

  test('R2: world state, native environment XML and every newer writer self id relocate by their structured locations', () => {
    const xml =
      '<environment_context><cwd>/work/source</cwd><filesystem><workspace_roots><root>/work/source/sub</root></workspace_roots></filesystem></environment_context>';
    const source =
      forkHeader('/fixture') +
      forkRow('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: xml }],
      }) +
      forkRow('world_state', {
        full: true,
        state: {
          environments: {
            environments: { local: { cwd: '/work/source' } },
            filesystem:
              '<filesystem><workspace_roots><root>/work/source</root><root>/independent</root></workspace_roots></filesystem>',
          },
        },
      }) +
      userRow('asked 1') +
      forkRow('event_msg', {
        type: 'thread_settings_applied',
        thread_id: SOURCE_ID,
        thread_settings: { cwd: '/work/source' },
      }) +
      forkRow('event_msg', { type: 'item_completed', thread_id: SOURCE_ID, item: { type: 'AgentMessage' } }) +
      forkRow('token_usage_record', { thread_id: SOURCE_ID, session_id: SOURCE_ID }) +
      assistantRow('done');
    const result = cut(source);
    expect(result.kind).toBe('cut');
    if (result.kind !== 'cut') throw new Error(result.reason);
    expect(result.text).not.toContain(SOURCE_ID);
    expect(result.text).not.toContain('/work/source');
    expect(result.text).toContain('<root>/work/fork/sub</root>');
    expect(result.text).toContain('<root>/independent</root>');
    expect(result.text).toContain('"full":true');
  });

  test('R2: unrecognized record types, events, fields and XML carrying identities or worktrees refuse', () => {
    for (const row of [
      forkRow('future_record', { thread_id: SOURCE_ID }),
      forkRow('future_record', { cwd: '/work/source' }),
      forkRow('future_record', { nested: { active: SOURCE_ID } }),
      forkRow('response_item', {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `<environment_context><thread_id>${SOURCE_ID}</thread_id></environment_context>`,
          },
        ],
      }),
      forkRow('event_msg', { type: 'future_event', thread_id: SOURCE_ID }),
      forkRow('turn_context', { cwd: '/work/source', new_workspace: { cwd: '/work/source' } }),
      forkRow('world_state', { state: { environments: { environments: { remote: { cwd: '/work/source' } } } } }),
      forkRow('world_state', {
        state: { environments: { filesystem: '<filesystem><future_root>/work/source</future_root></filesystem>' } },
      }),
    ]) {
      expect(cut(forkHeader('/fixture') + nativeTurn(1) + row)).toMatchObject({
        kind: 'refused',
        reason: expect.stringMatching(/untested identity\/worktree field/u),
      });
    }
  });

  test('R2: quoted history and tool arguments stay intact while known environment XML handles escaped paths', () => {
    const original = '/work/a&b';
    const quoted = `quoted ${SOURCE_ID} /work/source`;
    const result = cutRollout(
      forkHeader('/fixture').replace('/work/source', original) +
        forkRow('response_item', {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<environment_context><cwd>/work/a&amp;b</cwd></environment_context>' },
          ],
        }) +
        userRow('asked 1') +
        forkRow('response_item', { type: 'function_call', call_id: 'tool', name: 'synthetic', arguments: quoted }) +
        forkRow('response_item', { type: 'function_call_output', call_id: 'tool', output: quoted }) +
        assistantRow(quoted),
      { turn: 1 },
      target,
    );
    expect(result.kind).toBe('cut');
    if (result.kind !== 'cut') throw new Error(result.reason);
    expect(result.text).toContain('<cwd>/work/fork</cwd>');
    expect(result.text.split(quoted)).toHaveLength(4);
  });
});
