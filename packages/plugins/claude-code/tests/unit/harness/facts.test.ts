import { describe, expect, test } from 'bun:test';
import { SKILLS_FOLDER } from '@ferretry/core-ferrets/contract';
import { CLAUDE_CODE_FACTS } from '../../../daemon/lib/harness/facts.ts';
import { HOME_FILES } from '../../../daemon/lib/harness/launch.ts';

/** What Claude Code says about itself as data (`Harness.facts`): pinned, and the home writer reads the same names. */
describe('Claude Code’s facts', () => {
  test('name the product, its instruction and MCP files, its skills folder, its parser and its catalog half', () => {
    expect(CLAUDE_CODE_FACTS).toEqual({
      displayName: 'Claude Code',
      instructionFile: 'CLAUDE.md',
      skillsDir: 'skills',
      mcp: { format: 'json', file: 'mcp.json' },
      transcriptFormat: 'claude',
      catalogHalf: 'claude',
    });
  });

  test('are the names the home writer uses, so there is one owner of each', () => {
    expect(HOME_FILES.memory).toBe(CLAUDE_CODE_FACTS.instructionFile);
    expect(HOME_FILES.mcp).toBe(CLAUDE_CODE_FACTS.mcp.file);
    expect(CLAUDE_CODE_FACTS.skillsDir).toBe(SKILLS_FOLDER);
  });
});
