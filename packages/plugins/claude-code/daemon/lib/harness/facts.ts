import { SKILLS_FOLDER, type HarnessFacts } from '@ferretry/core-ferrets/contract';

/**
 * What Claude Code says about itself as data (`Harness.facts`, `FerretsApi.harnessFacts`). This plugin's own home writer
 * (`HOME_FILES`) reads the instruction and MCP file names from here, so there is one owner and no drift.
 */
export const CLAUDE_CODE_FACTS: HarnessFacts = {
  displayName: 'Claude Code',
  instructionFile: 'CLAUDE.md',
  skillsDir: SKILLS_FOLDER,
  mcp: { format: 'json', file: 'mcp.json' },
  transcriptFormat: 'claude',
  catalogHalf: 'claude',
};
