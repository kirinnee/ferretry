import type { ConfiguredServer } from './harness-provenance.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A project's `.mcp.json` as data. `null` (no file) and blank text are an empty document; text that is not JSON, is not
 * an object, or whose `mcpServers` is not an object is refused (the MCP plugin's own parser refuses the same three,
 * and a refusal here explains no process).
 */
function parseProjectFile(text: string | null): Readonly<Record<string, unknown>> {
  if (text === null || text.trim() === '') return {};
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('.mcp.json is not a JSON object');
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))
    throw new Error('.mcp.json has an "mcpServers" that is not an object');
  return parsed;
}

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
    document = parseProjectFile(text);
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
