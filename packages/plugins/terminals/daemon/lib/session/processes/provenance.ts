/**
 * Which processes in a pane's tree are the agent's OWN (today's `harness-provenance.ts` and
 * `configured-servers.ts`, the part the Processes tab reads; the same rules the Warden uses).
 */

/** `fy mcp serve`: the words after the binary that start Ferretry's tools server (today's `FERRETRY_MCP_ARGS`). */
const FERRETRY_MCP_ARGS: readonly string[] = ['mcp', 'serve'];
/** Claude's status line subcommand (today's `STATUSLINE_SUBCOMMAND`). */
const STATUSLINE_SUBCOMMAND = 'statusline';

/** One row of the pane's tree, parents before children. */
export interface ProcRow {
  readonly pid: number;
  readonly ppid: number;
  readonly startedSecondsAgo: number;
  readonly argv: string;
}
/** Why a process in the pane's tree is the agent's own and therefore restarts with its CLI. */
type KnownProcessKind = 'ferretry-tools' | 'status-line' | 'harness' | 'language-server' | 'configured-server';

export interface KnownProcess {
  readonly kind: KnownProcessKind;
  /** The plain-words name the confirmation shows. */
  readonly label: string;
}

/** A tool server the project's own configuration asks the harness to start. */
export interface ConfiguredServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface Provenance {
  /** The pane's own pid: everything the harness starts is below it. */
  readonly rootPid: number;
  /** The CLI's binary name (`fy`), single-sourced by the composition root. */
  readonly binaryName: string;
  readonly configuredServers: readonly ConfiguredServer[];
}

const RUNTIMES = new Set(['node', 'nodejs', 'bun', 'deno']);
const HARNESS_NAME = /^\.?(claude|codex)(-[\w.-]+)?$/;
const HARNESS_PATH = /\/(@anthropic-ai\/claude-code|@openai\/codex)\//;
const LANGUAGE_SERVERS = new Set(
  'typescript-language-server tsserver gopls rust-analyzer pyright pyright-langserver pylsp clangd lua-language-server nixd nil jdtls vscode-json-language-server vscode-css-language-server bash-language-server yaml-language-server'.split(
    ' ',
  ),
);

const basename = (word: string): string => word.split('/').at(-1) ?? '';
const stem = (word: string): string => basename(word).replace(/\.(?:[cm]?js|ts)$/, '');
const tokensOf = (argv: string): readonly string[] => argv.split(/\s+/).filter(Boolean);

/** The program a row runs: the script when a JavaScript runtime was handed one, else the head word. */
function program(values: readonly string[]): string {
  const head = values[0] ?? '';
  if (!RUNTIMES.has(basename(head))) return head;
  return values.slice(1).find(value => !value.startsWith('-')) ?? head;
}

function isHarnessCli(values: readonly string[]): boolean {
  const target = program(values);
  return HARNESS_NAME.test(stem(target)) || HARNESS_PATH.test(target);
}

/** `fy mcp serve`, however the runtime was spelled: `fy`, `/nix/store/…/bin/fy`, `bun …/fy.ts`. */
function isToolsServer(values: readonly string[], binaryName: string): boolean {
  const at = values.findIndex(value => stem(value) === binaryName);
  if (at === -1 || at > 2) return false;
  return FERRETRY_MCP_ARGS.every((word, offset) => values[at + 1 + offset] === word);
}

/** A word as the shell would read it: `ps` shows `sh -c 'fy' statusline` with the quotes the command was written with. */
const unquoted = (word: string): string => word.replace(/^'(.*)'$/u, '$1');

/**
 * Claude's `statusLine.command`, which every Claude runtime is materialised with as
 * `claudeStatuslineCommand` writes it — `'fy' statusline [--then '<own command>']` — and which Claude
 * runs through `sh -c` after every turn. Matched as the tools server is, by the binary name and the
 * subcommand, wherever the shell or a runtime put them: `sh -c 'fy' statusline`, `fy statusline`,
 * `bun …/fy.ts statusline`.
 */
function isStatusLine(values: readonly string[], binaryName: string): boolean {
  const words = values.map(unquoted);
  const at = words.findIndex(value => stem(value) === binaryName);
  return at !== -1 && at <= 3 && words[at + 1] === STATUSLINE_SUBCOMMAND;
}

function containsSequence(values: readonly string[], wanted: readonly string[]): boolean {
  if (wanted.length === 0) return false;
  for (let start = 0; start + wanted.length <= values.length; start++)
    if (wanted.every((word, offset) => values[start + offset] === word)) return true;
  return false;
}

/**
 * `npx -y foo-mcp` shows up as `npm exec foo-mcp`, so flags are ignored and the first positional
 * words are what must appear, in order. A server configured with no arguments is matched by program.
 */
function matchesConfigured(values: readonly string[], server: ConfiguredServer): boolean {
  const words = server.args.filter(word => !word.startsWith('-'));
  if (words.length > 0) return containsSequence(values.map(stem), words.map(stem));
  return stem(program(values)) === stem(server.command);
}

function identify(values: readonly string[], provenance: Provenance): KnownProcess | undefined {
  if (isToolsServer(values, provenance.binaryName))
    return { kind: 'ferretry-tools', label: 'The Ferretry tools server' };
  // Before the harness check: the person's own status line it chains can be named anything at all.
  if (isStatusLine(values, provenance.binaryName)) return { kind: 'status-line', label: 'The agent’s status line' };
  if (isHarnessCli(values)) return { kind: 'harness', label: 'The agent’s own CLI' };
  const head = stem(program(values));
  if (LANGUAGE_SERVERS.has(head)) return { kind: 'language-server', label: `The ${head} language server` };
  const configured = provenance.configuredServers.find(server => matchesConfigured(values, server));
  return configured === undefined
    ? undefined
    : { kind: 'configured-server', label: `The “${configured.name}” tool server from the project config` };
}

/**
 * The processes in a pane's tree that are the agent's OWN, found by where they came from.
 *
 * A name alone never qualifies: the row must also be a child of the pane or of a harness (a CLI the pane runs).
 * An `fy mcp serve` typed into one of the agent's shells, or a `codex` it launched through a tool
 * call, is parented by that shell and stays unclassified — work the agent started is not the
 * harness's own. A child of a recognised helper (the `node` an `npx` server spawns) is inherited,
 * because it was started on the helper's behalf.
 *
 * `rows` must list parents before children, which {@link descendantsOf} guarantees.
 */
export function identifyKnownProcesses(
  rows: readonly ProcRow[],
  provenance: Provenance,
): ReadonlyMap<number, KnownProcess> {
  const known = new Map<number, KnownProcess>();
  for (const row of rows) {
    const parent = known.get(row.ppid);
    const harnessSpawned = row.ppid === provenance.rootPid || parent?.kind === 'harness';
    if (parent !== undefined && parent.kind !== 'harness') {
      known.set(row.pid, parent);
      continue;
    }
    if (!harnessSpawned) continue;
    const found = identify(tokensOf(row.argv), provenance);
    if (found !== undefined) known.set(row.pid, found);
  }
  return known;
}

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
  if (text === null || text.trim() === '') return [];
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(document) || (document.mcpServers !== undefined && !isRecord(document.mcpServers))) return [];
  const servers = isRecord(document.mcpServers) ? document.mcpServers : {};
  const found: ConfiguredServer[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (!isRecord(entry) || typeof entry.command !== 'string' || entry.command === '') continue;
    const args = Array.isArray(entry.args) ? entry.args.filter((word): word is string => typeof word === 'string') : [];
    found.push({ name, command: entry.command, args });
  }
  return found;
}
