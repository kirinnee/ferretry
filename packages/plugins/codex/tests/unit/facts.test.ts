import { describe, expect, test } from 'bun:test';
import { SKILLS_FOLDER } from '@ferretry/core-ferrets/contract';
import { CODEX_FACTS } from '../../daemon/lib/facts.ts';

/** What Codex says about itself as data (`Harness.facts`): pinned; the home writer reads these file names. */
describe('Codex’s facts', () => {
  test('name the product, its instruction and MCP files, its skills folder, its parser and its catalog half', () => {
    expect(CODEX_FACTS).toEqual({
      displayName: 'Codex',
      instructionFile: 'AGENTS.md',
      skillsDir: 'skills',
      mcp: { format: 'toml', file: 'config.toml' },
      transcriptFormat: 'codex',
      catalogHalf: 'codex',
      historyPool: 'codex',
      paneReportsBackgroundTerminals: true,
    });
    expect(CODEX_FACTS.skillsDir).toBe(SKILLS_FOLDER);
  });
});
