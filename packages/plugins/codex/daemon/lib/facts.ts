import { SKILLS_FOLDER, type HarnessFacts } from '@ferretry/core-ferrets/contract';

/**
 * What Codex says about itself as data (`Harness.facts`, `FerretsApi.harnessFacts`). This plugin's own home writer
 * reads the instruction and MCP file names from here, so there is one owner and no drift.
 */
export const CODEX_FACTS: HarnessFacts = {
  displayName: 'Codex',
  instructionFile: 'AGENTS.md',
  skillsDir: SKILLS_FOLDER,
  mcp: { format: 'toml', file: 'config.toml' },
  transcriptFormat: 'codex',
  catalogHalf: 'codex',
  historyPool: 'codex',
  paneReportsBackgroundTerminals: true,
};
