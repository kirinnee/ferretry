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
