/**
 * Context — what one agent has where it is working, as rows a person can search and filter. Pure.
 *
 * The rail shows four facts about one agent in one folder: what it is waiting on you for (Signals), the
 * MCP servers it can reach (MCP), the skills it can run (Skills) and the instruction files it reads
 * (Instructions). Every one of those facts has an owner elsewhere — the agenda board, the MCP and skills
 * inventories (docs/mcp-scopes.md), the session filesystem — and this module owns none of
 * them. It owns only the ROWS: which chip a row falls under, what a search matches, and the one short
 * line each row says about itself.
 *
 * Each sub-tab answers the same three questions so one panel can draw all four: what are the chips, how
 * many rows does each hold under the current search, and which rows are showing.
 */

import type {
  AgendaItem,
  AgendaSnapshot,
  McpInventoryServer,
  ResolvedAgendaItem,
  SessionFsEntry,
  SkillEntry,
  SkillScope,
} from '@ferretry/protocol';
import { formatBytes } from '../../components/files-model.ts';
import { relativeTime } from '../../lib/session-screens.ts';
import { agendaKindMeta, describeResponse } from '../agenda/agenda-board.tsx';
import {
  checkResultOf,
  MCP_SCOPE_LABEL,
  type McpCheckState,
  mcpRowStatus,
  SKILL_SCOPE_LABEL,
} from '../mcp/mcp-model.ts';

// ── The sub-tabs ─────────────────────────────────────────────────────────────────────────────────

export type ContextRailTab = 'signals' | 'files' | 'mcp' | 'skills' | 'docs';

export const CONTEXT_RAIL_TABS: readonly ContextRailTab[] = ['signals', 'mcp', 'skills', 'docs'];

/** Info › Folder's sub-tabs: the folder itself, then what the agent reads and reaches from it. */
export const FOLDER_TABS: readonly ContextRailTab[] = ['files', 'docs', 'skills', 'mcp'];

export const CONTEXT_RAIL_TAB_LABEL: Readonly<Record<ContextRailTab, string>> = {
  signals: 'Signals',
  files: 'Files',
  mcp: 'MCP',
  skills: 'Skills',
  docs: 'Instructions',
};

/** What the search box says it searches, per sub-tab. */
export const CONTEXT_RAIL_SEARCH_LABEL: Readonly<Record<ContextRailTab, string>> = {
  signals: 'Search signals',
  files: 'Search files',
  mcp: 'Search MCP servers',
  skills: 'Search skills',
  docs: 'Search instructions',
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
  | { readonly state: 'open'; readonly item: AgendaItem }
  | { readonly state: 'answered'; readonly item: ResolvedAgendaItem };

/** Open items first, oldest wait first; answered ones after, most recent first. A parked item (snoozed, or replied
 * to) is neither: it waits on nobody, and the Inbox lists it under Snoozed or Replied. */
export const signalRows = (snapshot: AgendaSnapshot): SignalRow[] => [
  ...snapshot.items
    .filter(item => item.parked === undefined)
    .sort((left, right) => Date.parse(left.waitingSince) - Date.parse(right.waitingSince))
    .map(item => ({ state: 'open' as const, item })),
  ...[...snapshot.resolved]
    .sort((left, right) => Date.parse(right.resolvedAt) - Date.parse(left.resolvedAt))
    .map(item => ({ state: 'answered' as const, item })),
];

/** What the row says it is: "question", "permission", "pick one". */
export const signalKind = (item: AgendaItem): string => agendaKindMeta(item).label.toLocaleLowerCase();

/** Who raised it: the agent that did, else the agent whose rail this is. */
export const signalAuthor = (item: AgendaItem, agentName: string): string =>
  item.raisedBy === 'agent' ? (item.raisedByName ?? agentName) : item.raisedBy === 'daemon' ? 'Ferretry' : 'You';

/** How an answered item ended, in a few words: “Start over”, "Approved", "dismissed". */
export const signalOutcome = (item: ResolvedAgendaItem): string => {
  if (item.response !== undefined) return describeResponse(item.response);
  if (item.disposition === 'replied') return 'Replied';
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

export type McpChip = 'all' | 'attention';

const MCP_CHIPS: readonly McpChip[] = ['all', 'attention'];
const MCP_CHIP_LABEL: Readonly<Record<McpChip, string>> = { all: 'All', attention: 'Needs attention' };

const mcpMatches = (server: McpInventoryServer, query: string): boolean =>
  matchesQuery(query, server.name, MCP_SCOPE_LABEL[server.scope], server.target);

const needsAgenda = (server: McpInventoryServer, checks: ReadonlyMap<string, McpCheckState>, nowMs: number): boolean =>
  mcpRowStatus(server, checkResultOf(checks, server.id), nowMs).attention;

/** The chips, counted under the current search. A Check's answer moves a server in or out of attention. */
export const mcpChips = (
  servers: readonly McpInventoryServer[],
  query: string,
  checks: ReadonlyMap<string, McpCheckState>,
  nowMs: number,
): ContextChip<McpChip>[] =>
  chipsFor(
    MCP_CHIPS,
    MCP_CHIP_LABEL,
    servers.filter(server => mcpMatches(server, query)),
    (server, chip) => chip === 'all' || needsAgenda(server, checks, nowMs),
  );

export const visibleMcpServers = (
  servers: readonly McpInventoryServer[],
  query: string,
  chip: McpChip,
  checks: ReadonlyMap<string, McpCheckState>,
  nowMs: number,
): McpInventoryServer[] =>
  servers.filter(server => mcpMatches(server, query) && (chip === 'all' || needsAgenda(server, checks, nowMs)));

// ── Skills ───────────────────────────────────────────────────────────────────────────────────────

export type SkillChip = 'all' | SkillScope;

const SKILL_CHIPS: readonly SkillChip[] = ['all', 'project', 'user', 'ferretry'];
const SKILL_CHIP_LABEL: Readonly<Record<SkillChip, string>> = { all: 'All', ...SKILL_SCOPE_LABEL };

const skillInChip = (skill: SkillEntry, chip: SkillChip): boolean => chip === 'all' || skill.scope === chip;

const skillMatches = (skill: SkillEntry, query: string): boolean =>
  matchesQuery(query, skill.name, skill.description, SKILL_SCOPE_LABEL[skill.scope]);

/**
 * The chips. A scope is offered only when this ferret has a skill from it: a permanently empty
 * "Project 0" chip on a ferret outside any project is a control that can never do anything.
 */
export const skillChips = (skills: readonly SkillEntry[], query: string): ContextChip<SkillChip>[] =>
  chipsFor(
    SKILL_CHIPS,
    SKILL_CHIP_LABEL,
    skills.filter(skill => skillMatches(skill, query)),
    skillInChip,
  ).filter(chip => chip.key === 'all' || skills.some(skill => skill.scope === chip.key));

export const visibleSkills = (skills: readonly SkillEntry[], query: string, chip: SkillChip): SkillEntry[] =>
  skills.filter(skill => skillInChip(skill, chip) && skillMatches(skill, query));

/** How many skills this ferret actually loads: the ones no other scope overrides. */
export const loadedSkillCount = (skills: readonly SkillEntry[]): number =>
  skills.filter(skill => skill.shadowedBy === undefined).length;

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
    files: 'This folder is empty.',
    mcp: 'This agent has no MCP servers.',
    skills: 'No skills are installed for this agent.',
    docs: 'No instruction files in this folder.',
  }[tab];
};
