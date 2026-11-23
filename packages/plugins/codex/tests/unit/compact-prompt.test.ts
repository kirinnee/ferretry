import { describe, expect, test } from 'bun:test';
import { COMPACTION_KEEP_LINES, COMPACTION_REABSORB_LINES } from '@ferretry/core-ferrets/contract';
import { codexCompactPrompt } from '../../daemon/lib/compact-prompt.ts';
import { buildCodexLaunchArgv } from '../../daemon/lib/launch.ts';
import { tomlString } from '../../daemon/lib/toml.ts';

const SESSION = 'mwk9aqzd-bd4e1844';
const CODEX_COMPACT_PROMPT = codexCompactPrompt(SESSION);

describe('the Codex compaction prompt', () => {
  test('still asks for the summary, because the setting replaces Codex’s own summary prompt', () => {
    expect(CODEX_COMPACT_PROMPT.split('\n')[0]).toContain('handoff summary');
  });

  test('carries the one keep text and the one re-read text Claude gets, with the ferret’s own session id filled in', () => {
    for (const line of COMPACTION_KEEP_LINES) expect(CODEX_COMPACT_PROMPT).toContain(line);
    for (const line of COMPACTION_REABSORB_LINES)
      expect(CODEX_COMPACT_PROMPT).toContain(line.replaceAll('%s', SESSION));
    expect(CODEX_COMPACT_PROMPT).not.toContain('%s');
  });

  test('the prompt a Codex ferret gets holds its id and no $FY_ text', () => {
    expect(CODEX_COMPACT_PROMPT).toContain(`This is session ${SESSION}.`);
    expect(CODEX_COMPACT_PROMPT).toContain(`fy logs ${SESSION} --turn 1`);
    expect(CODEX_COMPACT_PROMPT).not.toContain('$FY_');
    expect(codexCompactPrompt('other-id')).not.toContain(SESSION);
  });

  test('says each thing once', () => {
    const lines = CODEX_COMPACT_PROMPT.split('\n');
    expect(new Set(lines).size).toBe(lines.length);
  });
});

describe('the Codex launch argv carries the compaction prompt', () => {
  test('as one -c compact_prompt override, a TOML string with the newlines escaped', () => {
    const argv = buildCodexLaunchArgv({ executable: 'codex', compactPrompt: CODEX_COMPACT_PROMPT });
    expect(argv).toEqual(['codex', '-c', `compact_prompt=${tomlString(CODEX_COMPACT_PROMPT)}`]);
    expect(argv[2]).not.toContain('\n');
  });

  test('before the launch’s own flags, and next to the trigger', () => {
    const argv = buildCodexLaunchArgv({
      executable: 'codex',
      compactAt: 1000,
      compactPrompt: 'p',
      harnessFlags: ['--sandbox=workspace-write'],
    });
    expect(argv).toEqual([
      'codex',
      '-c',
      'model_auto_compact_token_limit=1000',
      '-c',
      'compact_prompt="p"',
      '--sandbox=workspace-write',
    ]);
  });

  test('is absent when none is given', () => {
    expect(buildCodexLaunchArgv({ executable: 'codex' })).toEqual(['codex']);
  });
});

/** The prompt's two tails before the work switch moved Board's lines out (the base wording, Board on). */
const BASE_KEEP =
  'When you summarise this conversation, keep: your assignment and how far you are; your task id and its status (now, done so far, next); your open agenda item ids; every message you still owe a reply to and who sent it; and the branch and PR links you own. After the compaction you will be told to read the assignment, the task, the agenda and the owed messages again, so the summary must name where each one is.';
const BASE_REABSORB = [
  `You were just compacted, so part of your earlier context is gone. This is session ${SESSION}.`,
  'Before you continue, take back in everything you still owe:',
  `1. Your assignment: read your first turn again with \`fy logs ${SESSION} --turn 1\`; it names the turn file to read and follow.`,
  '2. Your board task, if you have one: `fy task show <task id>` (add --yaml for the editable form); if you do not know the id, `fy board status` says whether the board is on.',
  '3. Your open agenda items: `fy agenda ls`, then `fy agenda show <id>` for each.',
  `4. Messages you still owe a reply to: \`fy transcript ${SESSION} --tail\`, then answer with \`fy reply <id> <text>\`.`,
  'Then carry on with your next step. Do not ask the owner for what your assignment or agenda already says.',
].join('\n');

const BOARD_ADDS = {
  reabsorb:
    'Your board task, if you have one: `fy task show <task id>` (add --yaml for the editable form); if you do not know the id, `fy board status` says whether the board is on.',
  keep: 'your task id and its status (now, done so far, next)',
  reread: 'the task',
};

const squash = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim();

describe('the Codex compaction prompt, with the work switch on and off', () => {
  test('with Board on (its compaction part) the word-for-word prompt carries the task lines: the base wording', () => {
    const prompt = codexCompactPrompt(SESSION, BOARD_ADDS);
    expect(squash(prompt)).toContain(squash(BASE_KEEP));
    expect(prompt).toContain(BASE_REABSORB);
    expect(prompt).toContain('fy task show <task id>');
    expect(prompt).toContain('fy board status');
    expect(prompt).not.toContain('%s');
  });

  test('with Board off (no part) it is core’s alone and names no task or board verb', () => {
    expect(codexCompactPrompt(SESSION)).toBe(CODEX_COMPACT_PROMPT);
    expect(CODEX_COMPACT_PROMPT).not.toMatch(/\bfy (?:task|board)\b/u);
    expect(CODEX_COMPACT_PROMPT).toContain('3. Messages you still owe');
  });
});
