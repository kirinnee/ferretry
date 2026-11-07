/**
 * Which of a project's `.mcp.json` servers Claude Code in one ferret's home approved, left pending or DISABLED — read
 * by this plugin from its OWN home, so MCP needs no root over it (lead ruling: MCP takes the answer through the
 * `approvedProjectServers` read). The rules are today's `mcp-inventory/declarations.ts` (`claudeApproval`,
 * `claudeApprovalKeys`, `claudeProjectEntry`) and the reads are today's `ProjectMcpLaunch` ones
 * (`mcp-inventory/project-sign-in.ts`: `<home>/.claude.json` and `<home>/settings.json`), copied.
 *
 * FAIL CLOSED (5.0, kept from the MCP launch fix): today read a home it could not read as "nothing disabled". Here a
 * document that is there and cannot be read — refused by the root, not a regular file, too large, not JSON — answers
 * `unreadable`, and MCP then binds no project server. A document that is not there was read: it disables nothing.
 * No answer quotes a document: a `.claude.json` holds far more than approvals.
 */
import type { FerretId, FencedPath, RootHandle } from '@ferretry/kernel/contract';
import type { ProjectServerApproval, ProjectServerApprovals, ProjectServerQuery } from '../../contract/index.ts';

/** Larger than any real one: a busy `.claude.json` runs to a few hundred kilobytes. */
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** The approval keys Claude reads, from wherever one document holds them. */
export interface ClaudeApprovalKeys {
  readonly enableAll?: boolean;
  readonly enabled: readonly string[];
  readonly disabled: readonly string[];
}

export function claudeApprovalKeys(document: unknown): ClaudeApprovalKeys {
  if (!isRecord(document)) return { enabled: [], disabled: [] };
  return {
    ...(typeof document.enableAllProjectMcpServers === 'boolean'
      ? { enableAll: document.enableAllProjectMcpServers }
      : {}),
    enabled: strings(document.enabledMcpjsonServers),
    disabled: strings(document.disabledMcpjsonServers),
  };
}

/** One project's entry in a Claude home's `.claude.json` (`projects[<root>]`), or undefined. */
export function claudeProjectEntry(claudeJson: unknown, root: string): unknown {
  if (!isRecord(claudeJson) || !isRecord(claudeJson.projects)) return undefined;
  return claudeJson.projects[root];
}

/**
 * Whether Claude in one home runs one `.mcp.json` server for one project.
 *
 * Read off Claude Code 2.1.281 with `claude mcp list` against a scratch config directory: a server is
 * "Pending approval" until it is in `projects[<root>].enabledMcpjsonServers` AND the folder's trust
 * question has been answered (`hasTrustDialogAccepted`); one in `disabledMcpjsonServers` is not listed
 * at all. `enableAllProjectMcpServers` (in the project entry or any settings document) approves every
 * one. A deny anywhere wins over an allow anywhere, the way Claude's settings merge denials.
 */
export function claudeApproval(
  name: string,
  projectEntry: unknown,
  settings: readonly ClaudeApprovalKeys[],
): ProjectServerApproval {
  const sources = [claudeApprovalKeys(projectEntry), ...settings];
  if (sources.some(keys => keys.disabled.includes(name))) return 'disabled';
  const trusted = isRecord(projectEntry) && projectEntry.hasTrustDialogAccepted === true;
  const allowed = sources.some(keys => keys.enableAll === true || keys.enabled.includes(name));
  return allowed && trusted ? 'approved' : 'pending';
}

type HomeDocument =
  | { readonly read: true; readonly value: unknown }
  | { readonly read: false; readonly reason: string };

const codeOf = (error: unknown): string | undefined => (error as { code?: string } | undefined)?.code;

/** One JSON document in the home, by name: `null` when it is not there or empty, a reason when it cannot be read. */
async function readHomeDocument(home: RootHandle, name: string): Promise<HomeDocument> {
  const unreadable = (why: string): HomeDocument => ({ read: false, reason: `${name} in the ferret's home ${why}.` });
  let text: string;
  try {
    const path = home.resolve(name);
    if (!path.ok) return unreadable('is outside what Ferretry may read');
    const resolved: FencedPath = path.value;
    const info = await home.stat(resolved);
    if (info === undefined) return { read: true, value: null };
    if (info.kind !== 'file') return unreadable('is not a regular file');
    if (info.size > MAX_DOCUMENT_BYTES) return unreadable('is too large to read');
    text = await home.readText(resolved, MAX_DOCUMENT_BYTES);
  } catch (error) {
    const code = codeOf(error);
    return unreadable(`could not be read${code === undefined ? '' : ` (${code})`}`);
  }
  if (text.trim() === '') return { read: true, value: null };
  try {
    return { read: true, value: JSON.parse(text) as unknown };
  } catch {
    // The parser's message can quote the document: say only what it is.
    return unreadable('is not valid JSON');
  }
}

/** `home(ferret)`: this plugin's own `agent-homes` root for that ferret's home. */
export class ClaudeProjectApprovals {
  constructor(private readonly home: (ferret: FerretId) => RootHandle) {}

  async approvedProjectServers(query: ProjectServerQuery): Promise<ProjectServerApprovals> {
    let home: RootHandle;
    try {
      home = this.home(query.ferret);
    } catch {
      return { state: 'unreadable', reason: "The ferret's home is outside what Ferretry may read." };
    }
    const [claudeJson, settings] = await Promise.all([
      readHomeDocument(home, '.claude.json'),
      readHomeDocument(home, 'settings.json'),
    ]);
    if (!claudeJson.read) return { state: 'unreadable', reason: claudeJson.reason };
    if (!settings.read) return { state: 'unreadable', reason: settings.reason };
    const root = query.root.replace(/(?<=.)\/+$/u, '');
    const entry = claudeProjectEntry(claudeJson.value, root);
    const keys = claudeApprovalKeys(settings.value);
    const servers: Record<string, ProjectServerApproval> = {};
    for (const name of query.servers) servers[name] = claudeApproval(name, entry, [keys]);
    return { state: 'read', servers };
  }
}
