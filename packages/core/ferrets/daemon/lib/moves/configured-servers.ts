import { parseMcpProjectFile } from '../session-mcp/project-file.ts';
import type { ConfiguredServer } from './harness-provenance.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads the stdio servers a project's `.mcp.json` asks the harness to start. */
export interface ConfiguredServersPort {
  /** Absent file, unreadable file and unparseable file all answer an empty list. */
  read(directory: string): Promise<readonly ConfiguredServer[]>;
}

/**
 * The command servers a `.mcp.json` text declares. URL servers start no local process and are
 * skipped; a text that is not a usable document declares none, so the processes it would have
 * explained stay unclassified rather than being guessed at.
 */
export function configuredServersOf(text: string | null): readonly ConfiguredServer[] {
  let document: Readonly<Record<string, unknown>>;
  try {
    document = parseMcpProjectFile(text);
  } catch {
    return [];
  }
  const servers = isRecord(document.mcpServers) ? document.mcpServers : {};
  const found: ConfiguredServer[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (!isRecord(entry) || typeof entry.command !== 'string' || entry.command === '') continue;
    const args = Array.isArray(entry.args) ? entry.args.filter((word): word is string => typeof word === 'string') : [];
    found.push({ name, command: entry.command, args });
  }
  return found;
}
