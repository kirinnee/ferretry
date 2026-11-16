/**
 * Codex's answer to `approvedProjectServers`. Codex has NO per-project approval of `.mcp.json` servers: it reads a
 * project's servers from `.codex/config.toml` (only for a project its own `config.toml` marks trusted), and today a
 * Codex launch is handed no project server's sign-in at all (`mcp-inventory/project-sign-in.ts` answers `{}` for any
 * runtime that is not Claude's; the inventory marks a Codex project sign-in unsupported). So the answer is always
 * `not-taken` — never "all approved", which would hand Codex a token today's code never gave it.
 */
import type { ProjectServerApprovals } from '../../contract/index.ts';

export const CODEX_PROJECT_SERVERS_NOT_TAKEN =
  'Codex reads a project’s MCP servers from .codex/config.toml, not .mcp.json, and is handed no project server’s sign-in.';

export const codexProjectApprovals = async (): Promise<ProjectServerApprovals> => ({
  state: 'not-taken',
  reason: CODEX_PROJECT_SERVERS_NOT_TAKEN,
});
