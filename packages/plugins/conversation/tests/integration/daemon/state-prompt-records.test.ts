import { describe, expect, test } from 'bun:test';
import type { AskRef } from '@ferretry/core-asks/contract';
import { CONVERSATION_STATE, PROMPT_WAIT_STATE } from '../../../contract/index.ts';
import { PromptAsks, type PromptRoster } from '../../../daemon/prompts/adapters/prompt-asks.ts';
import { StatePromptRecords } from '../../../daemon/prompts/adapters/state-prompt-records.ts';
import { memoryStatePort } from '../../support/state.ts';

const record = { format: 1, key: 'permission:a', occurrence: 1, waiting: true } as const;

describe('the state-backed prompt records', () => {
  test('keep one record per ferret, list them, replace them whole and remove them', async () => {
    const records = new StatePromptRecords(memoryStatePort(CONVERSATION_STATE));

    expect(await records.list()).toEqual([]);
    expect(await records.read('f1')).toBeUndefined();
    await records.write('f1', record);
    await records.write('f1', { ...record, occurrence: 2, waiting: false });
    expect(await records.list()).toEqual(['f1']);
    expect(await records.read('f1')).toMatchObject({ occurrence: 2, waiting: false });
    await records.remove('f1');
    expect(await records.list()).toEqual([]);
  });

  test('a record that cannot be read is an error, never "no record"', async () => {
    const state = {
      ...memoryStatePort(CONVERSATION_STATE),
      read: async () => ({
        ok: false,
        error: { file: 'prompt-wait.json', reason: 'unparsable', sentence: 'prompt-wait.json is unparsable' },
      }),
    };
    await expect(new StatePromptRecords(state as never).read('f1')).rejects.toThrow('is unparsable');
  });

  test('a restart in the middle of a wait finds the same card through the state files, and the same prompt later is the next occurrence', async () => {
    const state = memoryStatePort(CONVERSATION_STATE);
    const roster: PromptRoster[] = [{ id: 'f1', state: 'idle' }];
    const raised = new Map<string, AskRef>();
    const port = {
      raise: async (draft: { entry: unknown; ferret?: string }) =>
        raised.get(String(draft.entry)) ??
        (raised.set(String(draft.entry), { ferret: draft.ferret ?? '', id: `A${raised.size + 1}` } as AskRef),
        raised.get(String(draft.entry))!),
      close: async () => undefined,
    };
    let read: { turnState: string; permissionRequest?: unknown } = {
      turnState: 'needs-input',
      permissionRequest: { id: 'p1', tool: 'Bash', question: 'Proceed?' },
    };
    const make = () =>
      new PromptAsks(
        port as never,
        async () => read as never,
        new StatePromptRecords(state),
        () => undefined,
      );

    await make().sweep(roster);
    await make().sweep(roster);
    expect(raised.size).toBe(1);
    expect(await state.read(PROMPT_WAIT_STATE, 'f1')).toMatchObject({
      ok: true,
      value: { occurrence: 1, waiting: true },
    });

    read = { turnState: 'working' };
    await make().sweep(roster);
    read = { turnState: 'needs-input', permissionRequest: { id: 'p1', tool: 'Bash', question: 'Proceed?' } };
    await make().sweep(roster);
    expect(raised.size).toBe(2);
    expect(await state.read(PROMPT_WAIT_STATE, 'f1')).toMatchObject({
      ok: true,
      value: { occurrence: 2, waiting: true },
    });
  });
});
