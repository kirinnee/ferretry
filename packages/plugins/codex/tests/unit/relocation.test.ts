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

  test.each(['0.144.0', '0.167.0', '0.200.1', '0.170.0-alpha.1', '0.170.0+build', ' 0.170.0', '0.170', '0.17.0'])(
    'a rollout written by the untested Codex %s is refused',
    version => {
      const result = relocateRollout(source([], version), { folder: TARGET_FOLDER, home: TARGET_HOME });
      expect(result).toEqual({ kind: 'refused', reason: expect.stringContaining(`Codex ${version}`) });
    },
  );

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

describe('what a move must not leave behind', () => {
  const deep = `${SOURCE_FOLDER}/a/b/c/d/e/f/g`;

  test('a deep folder under the work folder is moved, in values and in the names the world state keys by', () => {
    const state = JSON.stringify({
      type: 'world_state',
      payload: { state: { agents_md: { [`${deep}/AGENTS.md`]: 'synthetic rules' }, roots: [deep] } },
    });
    const context = JSON.stringify({
      type: 'turn_context',
      session_id: SOURCE_ID,
      payload: { cwd: deep, workspace_roots: [deep], sandbox_policy: { cwd: deep, writable_roots: [deep] } },
    });
    const result = moved(relocateRollout(source([state, context]), { folder: TARGET_FOLDER, home: TARGET_HOME }));
    expect(result.text).not.toContain(SOURCE_FOLDER);
    expect(result.text).toContain(`${TARGET_FOLDER}/a/b/c/d/e/f/g/AGENTS.md`);
  });

  test.each([
    [
      'an attachment record',
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: `${SOURCE_FOLDER}/shot.png` }],
        },
      },
    ],
    [
      'a path in a name outside the world state',
      { type: 'event_msg', payload: { type: 'mystery', files: { [`${SOURCE_FOLDER}/x`]: 1 } } },
    ],
  ])('%s that keeps the source path refuses the whole move rather than leaking it', (_label, record) => {
    const result = relocateRollout(source([JSON.stringify(record)]), { folder: TARGET_FOLDER, home: TARGET_HOME });
    expect(result).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('untested identity/worktree field'),
    });
  });

  test('a conversation with no turn yet is refused: Codex would have nothing to resume', () => {
    const text = source()
      .split('\n')
      .filter(row => !row.includes('SYNTHETIC_QUESTION'))
      .join('\n');
    expect(relocateRollout(text, { folder: TARGET_FOLDER, home: TARGET_HOME })).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('no turn yet'),
    });
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

describe('a native path that points outside the worktree and the home', () => {
  const OUTSIDE = '/local/original-checkout';
  const refusedFor = (record: unknown, where = OUTSIDE) =>
    expect(relocateRollout(source([JSON.stringify(record)]), { folder: TARGET_FOLDER, home: TARGET_HOME })).toEqual({
      kind: 'refused',
      reason: expect.stringContaining(where),
    });
  const movedFor = (record: unknown) =>
    moved(relocateRollout(source([JSON.stringify(record)]), { folder: TARGET_FOLDER, home: TARGET_HOME }));
  const exec = (workdir: string) => ({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'exec_command',
      call_id: 'call_exec',
      arguments: JSON.stringify({ cmd: 'pwd', workdir }),
    },
  });
  const turnContext = (original: string) => ({
    type: 'turn_context',
    session_id: SOURCE_ID,
    payload: { cwd: SOURCE_FOLDER, worktree: { original_cwd: original } },
  });
  const userMessage = (image: string) => ({
    type: 'event_msg',
    session_id: SOURCE_ID,
    payload: { type: 'user_message', message: 'SYNTHETIC_QUESTION', local_images: [image], images: [] },
  });
  const completed = (image: string) => ({
    type: 'event_msg',
    session_id: SOURCE_ID,
    payload: {
      type: 'item_completed',
      thread_id: SOURCE_ID,
      item: {
        type: 'UserMessage',
        id: 'item-1',
        content: [
          { type: 'local_image', path: image },
          { type: 'text', text: 'SYNTHETIC_QUESTION', text_elements: [] },
        ],
      },
    },
  });
  const tagged = (image: string) => ({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: `<image name=[Image #1] path="${image}">` },
        { type: 'input_text', text: 'image content omitted because it could not be processed' },
        { type: 'input_text', text: '</image>' },
      ],
    },
  });

  test.each([
    ['a command’s working folder', exec],
    ['the original checkout of a worktree', turnContext],
    ['an attached image (the older writer’s list)', userMessage],
    ['an attached image (the newer writer’s item)', completed],
    ['an attached image (the words the model was shown)', tagged],
  ])('%s outside the worktree refuses the move, naming it', (_label, build) => {
    refusedFor(build(OUTSIDE));
  });

  test.each([
    ['a command’s working folder', exec],
    ['the original checkout of a worktree', turnContext],
    ['an attached image (the older writer’s list)', userMessage],
    ['an attached image (the newer writer’s item)', completed],
    ['an attached image (the words the model was shown)', tagged],
  ])('%s that climbs out of the worktree refuses the move', (_label, build) => {
    refusedFor(build(`${SOURCE_FOLDER}/../orig`), `${SOURCE_FOLDER}/../orig`);
  });

  test.each([
    ['a command’s working folder', exec],
    ['the original checkout of a worktree', turnContext],
    ['an attached image (the older writer’s list)', userMessage],
    ['an attached image (the newer writer’s item)', completed],
    ['an attached image (the words the model was shown)', tagged],
  ])('%s inside the worktree is moved, and the source path is nowhere', (_label, build) => {
    const result = movedFor(build(`${SOURCE_FOLDER}/src/example.png`));
    expect(result.text).not.toContain(SOURCE_FOLDER);
    expect(result.text).toContain(`${TARGET_FOLDER}/src/example.png`);
  });

  test('a working folder inside the worktree is moved inside the command’s arguments, and nothing else of them changes', () => {
    const result = movedFor(exec(`${SOURCE_FOLDER}/src`));
    const call = records(result.text).find(record => record.payload.type === 'function_call');
    expect(JSON.parse(call?.payload.arguments as string)).toEqual({ cmd: 'pwd', workdir: `${TARGET_FOLDER}/src` });
  });

  test('a relative working folder is left as it is', () => {
    const result = movedFor(exec('src'));
    const call = records(result.text).find(record => record.payload.type === 'function_call');
    expect(JSON.parse(call?.payload.arguments as string)).toEqual({ cmd: 'pwd', workdir: 'src' });
  });

  test('a source home with spaces in its name leaves no part of it behind, and the new marker is whole', () => {
    const home = '/state/my codex homes/f 1';
    const result = moved(
      relocateRollout(syntheticRollout({ id: SOURCE_ID, folder: SOURCE_FOLDER, home }), {
        folder: TARGET_FOLDER,
        home: TARGET_HOME,
      }),
    );
    expect(result.text).not.toContain('my codex homes');
    expect(result.text).not.toContain('codex-correlation/unreachable');
    expect(records(result.text)[0]?.payload.runtime_workspace_roots).toEqual([
      `${TARGET_HOME}/codex-correlation/relocated`,
    ]);
    expect(result.text).toContain(`<root>${TARGET_FOLDER}/src</root>`);
  });
});

describe('the records a move reads field by field', () => {
  const NEW_ID = '019fab95-ffff-7000-8000-000000000002';

  test('the settings a turn applied move their folder and take the new id in every self field', () => {
    const applied = {
      type: 'event_msg',
      session_id: SOURCE_ID,
      payload: {
        type: 'thread_settings_applied',
        session_id: SOURCE_ID,
        thread_id: SOURCE_ID,
        thread_settings: { cwd: `${SOURCE_FOLDER}/src`, workspace_roots: [SOURCE_FOLDER] },
      },
    };
    const result = moved(
      relocateRollout(source([JSON.stringify(applied)]), { folder: TARGET_FOLDER, home: TARGET_HOME, id: NEW_ID }),
    );
    const found = records(result.text).find(record => record.payload.type === 'thread_settings_applied');
    expect(found?.payload).toMatchObject({
      session_id: NEW_ID,
      thread_id: NEW_ID,
      thread_settings: { cwd: TARGET_FOLDER, workspace_roots: [TARGET_FOLDER] },
    });
    expect(result.text).not.toContain(SOURCE_ID);
  });

  test('a token usage record takes the new id too', () => {
    const usage = {
      type: 'token_usage_record',
      session_id: SOURCE_ID,
      payload: { session_id: SOURCE_ID, thread_id: SOURCE_ID, total: 7 },
    };
    const result = moved(
      relocateRollout(source([JSON.stringify(usage)]), { folder: TARGET_FOLDER, home: TARGET_HOME, id: NEW_ID }),
    );
    expect(records(result.text).find(record => record.type === 'token_usage_record')?.payload).toEqual({
      session_id: NEW_ID,
      thread_id: NEW_ID,
      total: 7,
    });
  });

  test('a folder the world state lists outside the work folder is not the work folder and stays as it is', () => {
    const world = {
      type: 'world_state',
      payload: { state: { environments: { filesystem: '<environment><root>/usr/share/dict</root></environment>' } } },
    };
    const result = moved(
      relocateRollout(source([JSON.stringify(world)]), { folder: TARGET_FOLDER, home: TARGET_HOME }),
    );
    expect(result.text).toContain('<root>/usr/share/dict</root>');
  });

  test.each([
    ['arguments that are not JSON', 'run it now'],
    ['arguments with no working folder', JSON.stringify({ cmd: 'pwd' })],
  ])('a command with %s is left exactly as it was said', (_label, said) => {
    const call = {
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', call_id: 'call_plain', arguments: said },
    };
    const result = moved(relocateRollout(source([JSON.stringify(call)]), { folder: TARGET_FOLDER, home: TARGET_HOME }));
    expect(records(result.text).find(record => record.payload.type === 'function_call')?.payload.arguments).toBe(said);
  });

  test('a rollout with no header is refused', () => {
    const text = source()
      .split('\n')
      .filter(row => !row.includes('"session_meta"'))
      .join('\n');
    expect(relocateRollout(text, { folder: TARGET_FOLDER, home: TARGET_HOME })).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('no header'),
    });
  });
});
