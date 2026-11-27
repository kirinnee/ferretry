/** The rollout rewrite a move to another machine does: pure, over synthetic rollouts, no disk. */
import { describe, expect, test } from 'bun:test';
import {
  relocateRollout,
  renamedRolloutPath,
  rolloutFolder,
  rolloutPathId,
  type Relocated,
} from '../../daemon/lib/relocation.ts';
import { SOURCE_FOLDER, SOURCE_ID, TARGET_FOLDER, rolloutPath, syntheticRollout } from '../support/relocation-world.ts';

const SOURCE_HOME = '/state/codex/agent-homes/f1';
const TARGET_HOME = '/state/codex/agent-homes/f2';
const source = (extra: Parameters<typeof syntheticRollout>[0]['extra'] = [], version = '0.166.0') =>
  syntheticRollout({ id: SOURCE_ID, folder: SOURCE_FOLDER, home: SOURCE_HOME, version, extra });
const moved = (result: Relocated) => {
  if (result.kind !== 'moved') throw new Error(result.reason);
  return result;
};
const records = (text: string) =>
  text
    .trimEnd()
    .split('\n')
    .map(row => JSON.parse(row) as { type: string; payload: Record<string, any> });

describe('relocating a rollout', () => {
  test('keeps the id and moves every work-folder field, and leaves nothing of the source in the file', () => {
    const result = moved(relocateRollout(source(), { folder: TARGET_FOLDER, home: TARGET_HOME }));
    expect(result.id).toBe(SOURCE_ID);
    expect(result.text).not.toContain(SOURCE_FOLDER);
    expect(result.text).not.toContain(SOURCE_HOME);
    const found = records(result.text);
    expect(found[0]?.payload).toMatchObject({ id: SOURCE_ID, cwd: TARGET_FOLDER });
    expect(found[0]?.payload.runtime_workspace_roots).toEqual([`${TARGET_HOME}/codex-correlation/relocated`]);
    const world = found.find(record => record.type === 'world_state');
    expect(world?.payload.state.environments.environments.local.cwd).toBe(TARGET_FOLDER);
    expect(world?.payload.state.environments.filesystem).toBe(
      `<environment><cwd>${TARGET_FOLDER}</cwd><root>${TARGET_FOLDER}/src</root></environment>`,
    );
    const context = found.find(record => record.type === 'turn_context');
    expect(context?.payload).toMatchObject({
      cwd: TARGET_FOLDER,
      workspace_roots: [TARGET_FOLDER, `${TARGET_HOME}/codex-correlation/relocated`],
    });
    expect(context?.payload.sandbox_policy).toEqual({ cwd: TARGET_FOLDER, writable_roots: [TARGET_FOLDER] });
  });

  test('moves only fields: the words that were said stay exactly as they were', () => {
    const said = JSON.stringify({
      timestamp: '2026-11-16T09:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `I edited ${SOURCE_FOLDER}/a.ts` }],
      },
    });
    const result = moved(relocateRollout(source([said]), { folder: TARGET_FOLDER, home: TARGET_HOME }));
    expect(result.text).toContain(`I edited ${SOURCE_FOLDER}/a.ts`);
  });

  test('the skills a developer message lists are the new home’s, not the source’s', () => {
    const listing = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [
          {
            type: 'input_text',
            text: `<skills_instructions>- s: x (file: ${SOURCE_HOME}/skills/.system/s/SKILL.md)</skills_instructions>`,
          },
        ],
      },
    });
    const result = moved(relocateRollout(source([listing]), { folder: TARGET_FOLDER, home: TARGET_HOME }));
    expect(result.text).toContain(`(file: ${TARGET_HOME}/skills/.system/s/SKILL.md)`);
    expect(result.text).not.toContain(SOURCE_HOME);
  });

  test('the world state’s skills are the new home’s too', () => {
    const state = JSON.stringify({
      type: 'world_state',
      payload: { full: true, state: { skills: [{ path: `${SOURCE_HOME}/skills/.system/s/SKILL.md` }] } },
    });
    const result = moved(relocateRollout(source([state]), { folder: TARGET_FOLDER, home: TARGET_HOME }));
    expect(result.text).toContain(`${TARGET_HOME}/skills/.system/s/SKILL.md`);
    expect(result.text).not.toContain(SOURCE_HOME);
  });

  test('a conversation that takes a new id has the old one nowhere, in any self field', () => {
    const id = '019fab95-ffff-7000-8000-000000000001';
    const result = moved(relocateRollout(source(), { folder: TARGET_FOLDER, home: TARGET_HOME, id }));
    expect(result.id).toBe(id);
    expect(result.text).not.toContain(SOURCE_ID);
    expect(records(result.text)[0]?.payload).toMatchObject({ id, session_id: id });
    expect(
      records(result.text)
        .filter(record => record.payload.session_id !== undefined)
        .every(record => record.payload.session_id === id),
    ).toBe(true);
  });

  test('the unflushed last line is not part of the conversation', () => {
    const result = moved(
      relocateRollout(`${source()}{"type":"event_msg","payload":{"type":"agent_mes`, {
        folder: TARGET_FOLDER,
        home: TARGET_HOME,
      }),
    );
    expect(result.text.endsWith('\n')).toBe(true);
    expect(result.text).not.toContain('agent_mes"');
  });

  test.each(['0.144.0', '0.167.0', '0.200.1'])('a rollout written by the untested Codex %s is refused', version => {
    const result = relocateRollout(source([], version), { folder: TARGET_FOLDER, home: TARGET_HOME });
    expect(result).toEqual({ kind: 'refused', reason: expect.stringContaining(`Codex ${version}`) });
  });

  test('a rollout whose header names no version is refused', () => {
    const text = source().replace(/"cli_version":"[^"]*",/u, '');
    expect(relocateRollout(text, { folder: TARGET_FOLDER, home: TARGET_HOME })).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('(unknown version)'),
    });
  });

  test('a conversation that uses a native subagent is refused', () => {
    const spawn = JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call', name: 'spawn_agent', call_id: 'c1', arguments: '{}' },
    });
    expect(relocateRollout(source([spawn]), { folder: TARGET_FOLDER, home: TARGET_HOME })).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('subagent'),
    });
  });

  test('a field that names the source folder where this does not know it refuses the whole conversation', () => {
    const odd = JSON.stringify({ type: 'event_msg', payload: { type: 'mystery', where: `${SOURCE_FOLDER}/x` } });
    expect(relocateRollout(source([odd]), { folder: TARGET_FOLDER, home: TARGET_HOME })).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('untested identity/worktree field'),
    });
  });

  test('a line that is not a record refuses, naming the line', () => {
    const text = source().replace('\n', '\nnot json\n');
    expect(relocateRollout(text, { folder: TARGET_FOLDER, home: TARGET_HOME })).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('line 2'),
    });
  });

  test('a header that names no folder refuses', () => {
    const text = source().replace(`"cwd":"${SOURCE_FOLDER}","cli_version"`, '"cli_version"');
    expect(relocateRollout(text, { folder: TARGET_FOLDER, home: TARGET_HOME })).toMatchObject({ kind: 'refused' });
  });
});

describe('a rollout path', () => {
  test('names its conversation, and only a plain rollout path does', () => {
    expect(rolloutPathId(rolloutPath(SOURCE_ID))).toBe(SOURCE_ID);
    for (const bad of [
      `../${rolloutPath(SOURCE_ID)}`,
      `/${rolloutPath(SOURCE_ID)}`,
      `sessions/2026/11/16/../../rollout-x-${SOURCE_ID}.jsonl`,
      `sessions/2026/11/16/rollout-x-${SOURCE_ID}.json`,
      `auth.json`,
      `sessions/2026/11/16/rollout-x-not-an-id.jsonl`,
    ])
      expect(rolloutPathId(bad)).toBeUndefined();
  });

  test('a new id is filed beside the old one under the same day and stamp', () => {
    const id = '019fab95-ffff-7000-8000-000000000001';
    const renamed = renamedRolloutPath(rolloutPath(SOURCE_ID), SOURCE_ID, id);
    expect(renamed).toBe(rolloutPath(id));
    expect(rolloutPathId(renamed)).toBe(id);
    expect(rolloutFolder(renamed)).toBe('sessions/2026/11/16');
  });
});
