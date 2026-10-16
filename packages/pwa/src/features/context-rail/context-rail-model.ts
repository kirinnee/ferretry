/**
 * "This folder" — what one agent has where it is working, as rows a person can search and filter. Pure.
 *
 * The rail shows four facts about one agent in one folder: what it is waiting on you for (Signals), the
 * MCP servers it can reach (MCP), the skills it can run (Skills) and the instruction files it reads
 * (Docs). Every one of those facts has an owner elsewhere — the attention board, the fleet catalogue and
 * its MCP sign-ins, the session skills catalog, the session filesystem — and this module owns none of
 * them. It owns only the ROWS: which chip a row falls under, what a search matches, and the one short
 * line each row says about itself.
 *
 * Each sub-tab answers the same three questions so one panel can draw all four: what are the chips, how
 * many rows does each hold under the current search, and which rows are showing.
 */

import type {
  AttentionItem,
  AttentionSnapshot,
  AvailableSkill,
  FleetComponentCatalog,
  McpOAuthConnection,
  ResolvedAttentionItem,
  SessionFsEntry,
} from '@ferretry/protocol';
import { formatBytes } from '../../components/files-model.ts';
import { relativeTime } from '../../lib/session-screens.ts';
import { attentionKindMeta, describeResponse } from '../attention/attention-board.tsx';
import { mcpSignInStatus, type McpSignInTone } from '../fleet/components/mcp-sign-in-model.ts';

// ── The sub-tabs ─────────────────────────────────────────────────────────────────────────────────

export type ContextRailTab = 'signals' | 'mcp' | 'skills' | 'docs';

export const CONTEXT_RAIL_TABS: readonly ContextRailTab[] = ['signals', 'mcp', 'skills', 'docs'];

export const CONTEXT_RAIL_TAB_LABEL: Readonly<Record<ContextRailTab, string>> = {
  signals: 'Signals',
  mcp: 'MCP',
  skills: 'Skills',
  docs: 'Docs',
};

/** What the search box says it searches, per sub-tab. */
export const CONTEXT_RAIL_SEARCH_LABEL: Readonly<Record<ContextRailTab, string>> = {
  signals: 'Search signals',
  mcp: 'Search MCP servers',
  skills: 'Search skills',
  docs: 'Search docs',
};

/** One filter chip: its key, its words, and how many rows it would show under the current search. */
export interface ContextChip<K extends string> {
  readonly key: K;
  readonly label: string;
  readonly count: number;
}

/** Case- and locale-insensitive substring search over every field a row offers. */
export const matchesQuery = (query: string, ...fields: readonly (string | null | undefined)[]): boolean => {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return true;
  return fields.some(field => field?.toLocaleLowerCase().includes(needle) === true);
};

const chipsFor = <K extends string, R>(
  order: readonly K[],
  labels: Readonly<Record<K, string>>,
  rows: readonly R[],
  inChip: (row: R, chip: K) => boolean,
): ContextChip<K>[] =>
  order.map(key => ({ key, label: labels[key], count: rows.filter(row => inChip(row, key)).length }));

// ── Signals ──────────────────────────────────────────────────────────────────────────────────────

export type SignalChip = 'open' | 'answered';

const SIGNAL_CHIPS: readonly SignalChip[] = ['open', 'answered'];
const SIGNAL_CHIP_LABEL: Readonly<Record<SignalChip, string>> = { open: 'Open', answered: 'Answered' };

export type SignalRow =
  | { readonly state: 'open'; readonly item: AttentionItem }
  | { readonly state: 'answered'; readonly item: ResolvedAttentionItem };

/** Open items first, oldest wait first; answered ones after, most recent first. */
export const signalRows = (snapshot: AttentionSnapshot): SignalRow[] => [
  ...[...snapshot.items]
    .sort((left, right) => Date.parse(left.waitingSince) - Date.parse(right.waitingSince))
    .map(item => ({ state: 'open' as const, item })),
  ...[...snapshot.resolved]
    .sort((left, right) => Date.parse(right.resolvedAt) - Date.parse(left.resolvedAt))
    .map(item => ({ state: 'answered' as const, item })),
];

/** What the row says it is: "question", "permission", "pick one". */
export const signalKind = (item: AttentionItem): string => attentionKindMeta(item).label.toLocaleLowerCase();

/** Who raised it: the agent that did, else the agent whose rail this is. */
export const signalAuthor = (item: AttentionItem, agentName: string): string =>
  item.raisedBy === 'agent' ? (item.raisedByName ?? agentName) : item.raisedBy === 'daemon' ? 'Ferretry' : 'You';

/** How an answered item ended, in a few words: “Start over”, "Approved", "dismissed". */
export const signalOutcome = (item: ResolvedAttentionItem): string => {
  if (item.response !== undefined) return describeResponse(item.response);
  return item.disposition === 'dismissed' ? 'Dismissed' : 'Done';
};

/** The line under a signal's title: "Hadi · 2m ago · question". */
export const signalMeta = (row: SignalRow, agentName: string, nowMs: number): string =>
  row.state === 'open'
    ? `${signalAuthor(row.item, agentName)} · ${relativeTime(row.item.waitingSince, nowMs)} · ${signalKind(row.item)}`
    : `${signalAuthor(row.item, agentName)} · ${relativeTime(row.item.resolvedAt, nowMs)} · answered`;

const signalMatches = (row: SignalRow, query: string): boolean =>
  matchesQuery(
    query,
    row.item.subject,
    row.item.why,
    row.item.raisedByName,
    row.state === 'answered' ? signalOutcome(row.item) : undefined,
  );

export const signalChips = (rows: readonly SignalRow[], query: string): ContextChip<SignalChip>[] =>
  chipsFor(
    SIGNAL_CHIPS,
    SIGNAL_CHIP_LABEL,
    rows.filter(row => signalMatches(row, query)),
    (row, chip) => row.state === chip,
  );

export const visibleSignals = (rows: readonly SignalRow[], query: string, chip: SignalChip): SignalRow[] =>
  rows.filter(row => row.state === chip && signalMatches(row, query));

// ── MCP ──────────────────────────────────────────────────────────────────────────────────────────

export type McpChip = 'all' | 'needs-sign-in';

const MCP_CHIPS: readonly McpChip[] = ['all', 'needs-sign-in'];
const MCP_CHIP_LABEL: Readonly<Record<McpChip, string>> = { all: 'All', 'needs-sign-in': 'Needs sign-in' };

/**
 * One MCP server this agent can reach, and where its sign-in stands.
 *
 * `status` is `undefined` for a server that does not sign in from Ferretry (a local command, or a web
 * address with no `auth: oauth`): there is nothing for a person to do about it here, and Ferretry has no
 * live probe of whether such a server is up, so the row does not pretend to know.
 */
export interface ContextMcpServer {
  readonly name: string;
  /** How the agent reaches it: a web address, or a command it runs. */
  readonly transport: 'url' | 'command';
  readonly signsIn: boolean;
  readonly connection?: McpOAuthConnection;
}

export interface McpRowStatus {
  readonly label: string;
  readonly tone: McpSignInTone | 'none';
  /** Whether the row offers Sign in. */
  readonly canSignIn: boolean;
  readonly signInLabel: string;
}

/** Where one server stands, in the sign-in surface's own words when it signs in. */
export const mcpRowStatus = (server: ContextMcpServer, nowMs: number): McpRowStatus => {
  if (!server.signsIn)
    return {
      label: server.transport === 'url' ? 'No sign-in needed' : 'Runs locally',
      tone: 'none',
      canSignIn: false,
      signInLabel: 'Sign in',
    };
  const status = mcpSignInStatus(server.connection, nowMs);
  return {
    label: status.title,
    tone: status.tone,
    canSignIn: status.tone === 'warn',
    signInLabel: status.signedInBefore ? 'Sign in again' : 'Sign in',
  };
};

const needsSignIn = (server: ContextMcpServer, nowMs: number): boolean => mcpRowStatus(server, nowMs).canSignIn;

/**
 * The MCP servers in a component catalogue, joined with where each sign-in stands.
 *
 * `runtime` narrows the list to the servers one runtime's profile stack uses — a session's `agent` IS its
 * runtime's name, which is what the catalogue's `usedBy.runtimes` lists. Without it every MCP server on
 * the machine is shown. Name-sorted so the list does not reorder between reads.
 */
export const contextMcpServers = (
  catalog: FleetComponentCatalog,
  connections: readonly McpOAuthConnection[],
  runtime?: string,
): ContextMcpServer[] => {
  const servers: ContextMcpServer[] = [];
  for (const group of catalog.kinds)
    for (const component of group.components) {
      const detail = component.detail;
      if (detail.kind !== 'mcp' || (runtime !== undefined && !component.usedBy.runtimes.includes(runtime))) continue;
      const connection = connections.find(entry => entry.component === component.name);
      servers.push({
        name: component.name,
        transport: detail.url === undefined ? 'command' : 'url',
        signsIn: detail.url !== undefined && detail.auth === 'oauth',
        ...(connection === undefined ? {} : { connection }),
      });
    }
  return servers.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
};

export const mcpChips = (servers: readonly ContextMcpServer[], query: string, nowMs: number): ContextChip<McpChip>[] =>
  chipsFor(
    MCP_CHIPS,
    MCP_CHIP_LABEL,
    servers.filter(server => matchesQuery(query, server.name)),
    (server, chip) => chip === 'all' || needsSignIn(server, nowMs),
  );

export const visibleMcpServers = (
  servers: readonly ContextMcpServer[],
  query: string,
  chip: McpChip,
  nowMs: number,
): ContextMcpServer[] =>
  servers.filter(server => matchesQuery(query, server.name) && (chip === 'all' || needsSignIn(server, nowMs)));

// ── Skills ───────────────────────────────────────────────────────────────────────────────────────

export type SkillChip = 'all' | 'claude' | 'codex' | 'generic';

const SKILL_CHIPS: readonly SkillChip[] = ['all', 'claude', 'codex', 'generic'];
const SKILL_CHIP_LABEL: Readonly<Record<SkillChip, string>> = {
  all: 'All',
  claude: 'Claude',
  codex: 'Codex',
  generic: 'Generic',
};

/** A skill made for one harness falls under it; one for both, or of unknown origin, is generic. */
const skillInChip = (skill: AvailableSkill, chip: SkillChip): boolean =>
  chip === 'all' ||
  (chip === 'generic' ? skill.origin === 'both' || skill.origin === 'unknown' : skill.origin === chip);

const skillMatches = (skill: AvailableSkill, query: string): boolean =>
  matchesQuery(query, skill.name, skill.description);

/**
 * The chips. Codex is offered only when the catalog has a Codex skill: a Claude agent's rail with a
 * permanently empty "Codex 0" chip is a control that can never do anything.
 */
export const skillChips = (skills: readonly AvailableSkill[], query: string): ContextChip<SkillChip>[] => {
  const chips = chipsFor(
    SKILL_CHIPS,
    SKILL_CHIP_LABEL,
    skills.filter(skill => skillMatches(skill, query)),
    skillInChip,
  );
  const hasCodex = skills.some(skill => skill.origin === 'codex');
  return chips.filter(chip => chip.key !== 'codex' || hasCodex);
};

export const visibleSkills = (skills: readonly AvailableSkill[], query: string, chip: SkillChip): AvailableSkill[] =>
  skills.filter(skill => skillInChip(skill, chip) && skillMatches(skill, query));

// ── Docs ─────────────────────────────────────────────────────────────────────────────────────────

export type DocChip = 'all' | 'claude' | 'generic';

const DOC_CHIPS: readonly DocChip[] = ['all', 'claude', 'generic'];
const DOC_CHIP_LABEL: Readonly<Record<DocChip, string>> = { all: 'All', claude: 'Claude', generic: 'Generic' };

/**
 * The instruction files an agent reads from the folder it works in, by name. Claude reads `CLAUDE.md`
 * (and the uncommitted `CLAUDE.local.md`); Codex and most other agents read `AGENTS.md`; Gemini reads
 * `GEMINI.md`. Order is the order they are listed in.
 */
export const INSTRUCTION_FILE_NAMES: readonly string[] = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'AGENTS.override.md',
  'GEMINI.md',
];

/** One instruction file in the agent's folder, by its path relative to that folder. */
export interface ContextDoc {
  readonly path: string;
  readonly name: string;
  readonly size?: number;
}

/** The instruction files in one directory listing, in `INSTRUCTION_FILE_NAMES` order. */
export const instructionDocs = (entries: readonly SessionFsEntry[], directory = ''): ContextDoc[] =>
  INSTRUCTION_FILE_NAMES.flatMap(name => {
    const entry = entries.find(candidate => candidate.name === name && candidate.type === 'file');
    if (entry === undefined || entry.denied === true || entry.escapes === true) return [];
    return [
      {
        path: directory === '' ? name : `${directory}/${name}`,
        name,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      },
    ];
  });

const docInChip = (doc: ContextDoc, chip: DocChip): boolean =>
  chip === 'all' || (chip === 'claude') === doc.name.startsWith('CLAUDE.');

export const docChips = (docs: readonly ContextDoc[], query: string): ContextChip<DocChip>[] =>
  chipsFor(
    DOC_CHIPS,
    DOC_CHIP_LABEL,
    docs.filter(doc => matchesQuery(query, doc.path)),
    docInChip,
  );

export const visibleDocs = (docs: readonly ContextDoc[], query: string, chip: DocChip): ContextDoc[] =>
  docs.filter(doc => docInChip(doc, chip) && matchesQuery(query, doc.path));

/** "12.5 KB", or nothing when the listing did not say. */
export const docSize = (doc: ContextDoc): string => formatBytes(doc.size);

// ── Empty states ─────────────────────────────────────────────────────────────────────────────────

/** Honest zero-state copy: a filtered-out list is not an empty one. */
export const contextEmptyCopy = (tab: ContextRailTab, total: number, query: string, chipLabel: string): string => {
  const needle = query.trim();
  if (total > 0 && needle !== '') return `Nothing under ${chipLabel} matches “${needle}”.`;
  if (total > 0) return `Nothing under ${chipLabel}.`;
  return {
    signals: 'Nothing is waiting on you here.',
    mcp: 'This agent has no MCP servers.',
    skills: 'No skills are installed for this agent.',
    docs: 'No instruction files in this folder.',
  }[tab];
};
