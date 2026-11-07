/**
 * What the warden's logic reads of its neighbours, restated as the smallest structural types and the few pure helpers
 * it needs (spine rule 1: a package never reaches into another's source). Each block names the plugin that owns the
 * fact; the sentence is copied from today's file so the two cannot drift apart unnoticed (`one fact, one owner`).
 */
import { z } from 'zod';

// ─── Ferrets: the status vocabulary and callsigns (today's `protocol/session-base.ts`, `system-callsigns.ts`) ─────
export const SessionStatusSchema = z.enum([
  'created',
  'starting',
  'running',
  'thinking',
  'tool_running',
  'awaiting_question',
  'awaiting_user',
  'interrupted',
  'rate_limited',
  'retrying',
  'kill_failed',
  'waiting',
  'completed',
  'failed',
  'stalled',
  'stopped',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export const SessionTurnStateSchema = z.enum(['working', 'your-turn', 'needs-input']);
export type SessionTurnState = z.infer<typeof SessionTurnStateSchema>;
export const SessionStateSchema = z.looseObject({
  status: SessionStatusSchema,
  permissionRequest: z.unknown().optional(),
  harnessDialog: z.looseObject({ kind: z.string(), title: z.string().optional() }).optional(),
});

export const SYSTEM_CALLSIGN_MAX_SEQUENCE = 0xff_ff_ff;
const SYSTEM_CALLSIGN_PATTERN = /^([a-z]+)-([0-9a-f]{1,6})$/iu;
export const systemCallsignName = (prefix: string, sequence: number): string =>
  `${prefix}-${sequence.toString(16).padStart(6, '0')}`;
export function systemCallsignSequence(prefix: string, name: string | undefined): number | undefined {
  const match = SYSTEM_CALLSIGN_PATTERN.exec((name ?? '').trim());
  if (match?.[1]?.toLowerCase() !== prefix || match[2] === undefined) return undefined;
  const sequence = Number.parseInt(match[2], 16);
  return sequence === 0 ? undefined : sequence;
}
export function nextSystemCallsignSequence(last: number, inUse: ReadonlySet<number>): number | undefined {
  const start = Number.isInteger(last) && last >= 0 && last <= SYSTEM_CALLSIGN_MAX_SEQUENCE ? last : 0;
  for (let step = 1; step <= SYSTEM_CALLSIGN_MAX_SEQUENCE; step += 1) {
    const candidate = ((start + step - 1) % SYSTEM_CALLSIGN_MAX_SEQUENCE) + 1;
    if (!inUse.has(candidate)) return candidate;
  }
  return undefined;
}
/** `warden-00002a` → `warden-00002A`: the prefix as stored, the hex digits uppercase. Any other name unchanged. */
export function displaySystemCallsign(callsign: string): string {
  const match = SYSTEM_CALLSIGN_PATTERN.exec(callsign.trim());
  const sequence = systemCallsignSequence((match?.[1] ?? '').toLowerCase(), callsign);
  if (match?.[1] === undefined || sequence === undefined) return callsign;
  return `${match[1].toLowerCase()}-${sequence.toString(16).toUpperCase().padStart(6, '0')}`;
}
/** Title-case a callsign for display: `hadi` → `Hadi`, `mary-jane` → `Mary-Jane`; a system callsign keeps its shape. */
export function displayAgentName(callsign: string): string {
  if (/^(warden|miner|guide)-[0-9a-f]{6}$/iu.test(callsign)) return displaySystemCallsign(callsign);
  return callsign
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}

// ─── Board: a card, named (today's `protocol/board-refs.ts`) ──────────────────────────────────────────────────────
export const BoardTaskIdSchema = z.string().min(1);
export type BoardTaskId = z.infer<typeof BoardTaskIdSchema>;
export const TaskRefSchema = z.strictObject({ machineId: z.string().min(1).optional(), id: BoardTaskIdSchema });
export type TaskRef = z.infer<typeof TaskRefSchema>;
/** How a card is written everywhere: `&F412`. */
export const formatTaskRef = (ref: Pick<TaskRef, 'id'>): string => `&${ref.id}`;
export const InstantSchema = z.iso.datetime({ offset: true });

// ─── Agenda/Asks: the limits and the words of one owner-facing notice (today's `protocol/agenda.ts`) ────────────────
export const MAX_AGENDA_SUBJECT_LENGTH = 240;
export const MAX_AGENDA_DETAIL_LENGTH = 2_048;
export const MAX_AGENDA_REASON_LENGTH = 1_024;
export const AGENDA_PUSH_TITLE_LENGTH = 40;
export const AGENDA_PUSH_BODY_LENGTH = 120;
export const MACHINE_AGENDA_ID = 'machine-agenda';
export type AgendaSource = 'task' | 'question' | 'agent-raised';
export type AgendaBy = 'human' | 'agent' | 'daemon';
export interface AgendaTerm {
  readonly term: string;
  readonly meaning: string;
}
/** Cut at a word, one line, with an ellipsis (`protocol/agenda-card.ts`). */
export const clipAtWord = (text: string, limit: number): string => {
  const line = text.replaceAll(/\s+/gu, ' ').trim();
  if (line.length <= limit) return line;
  const room = line.slice(0, limit - 1);
  const space = room.lastIndexOf(' ');
  const cut = space >= Math.floor(limit / 2) ? room.slice(0, space) : room;
  return `${cut.trimEnd().replace(/[\s,;:.\-–—]+$/u, '')}…`;
};

// ─── Conversation: a message waiting in a ferret's queue (the fields the stuck-inbox rule reads) ─────────────────────
export interface QueuedMessage {
  readonly id: string;
  readonly state: 'queued' | 'typing' | 'delivered' | 'cancelled' | string;
  readonly sender: 'human' | 'agent' | 'daemon' | string;
  readonly label?: string;
  readonly interrupt?: boolean;
  readonly replyExpected?: boolean;
  readonly enqueuedAt: string;
  readonly holdUntil?: string;
  readonly waitReason?: string;
  readonly deliveredAs?: string;
  readonly waitBehind?: string;
  readonly [key: string]: any;
}

// ─── Board: a card as the orphan rule and the resume brief read it ───────────────────────────────────────────────────
export interface PrLink {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly draft?: boolean;
}
export interface BoardTaskEvent {
  readonly type: string;
  readonly at: string;
  readonly [key: string]: any;
}
export interface BoardTask {
  readonly id: BoardTaskId;
  readonly title: string;
  readonly owner: string;
  readonly assignee?: string | null;
  readonly laneId: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly lastTouchedAt?: string;
  readonly [key: string]: any;
}
export interface BoardTaskView extends BoardTask {
  readonly activity?: unknown;
  readonly ask: { readonly source: string; readonly text: string };
  readonly clarifications: readonly { readonly source: string; readonly text: string }[];
  readonly links: {
    readonly prs: readonly PrLink[];
    readonly branch: string | null;
    readonly commits: readonly string[];
    readonly docs: readonly string[];
  };
  readonly history: readonly BoardTaskEvent[];
}
export interface LaneSet {
  readonly lanes: readonly { readonly id: string; readonly name: string; readonly category?: string }[];
  readonly [key: string]: any;
}
export type LaneSets = ReadonlyMap<string, LaneSet>;
/** The card's working ferret: the assignee, else the owner (`board/authority.ts`). */
export const effectiveAssignee = (card: Pick<BoardTask, 'owner' | 'assignee'>): string => card.assignee ?? card.owner;

type BoardNamer = (id: string) => string;
const counted = (count: number, one: string): string => `${count} ${count === 1 ? one : `${one}s`}`;
const attachmentsPhrase = (files: readonly { readonly mime: string }[]): string => {
  const images = files.filter(file => file.mime.startsWith('image/')).length;
  const others = files.length - images;
  return [images > 0 ? counted(images, 'image') : null, others > 0 ? counted(others, 'file') : null]
    .filter(part => part !== null)
    .join(' and ');
};
/** One history line of a card (`protocol/board-history.ts`). */
export function describeBoardEvent(event: BoardTaskEvent, lane: BoardNamer, names: BoardNamer): string {
  switch (event.type) {
    case 'created':
      return `created in ${lane(event.laneId)}`;
    case 'moved': {
      const why = event.reason === null ? '' : `: ${event.reason}`;
      const moved = `${event.backward ? 'moved back' : 'moved'} ${lane(event.from)} → ${lane(event.to)}`;
      if (event.reportedBy !== undefined) return `reported ${event.trigger ?? 'a trigger'} → ${moved}${why}`;
      const auto = event.auto === true ? ` (auto${event.trigger === undefined ? '' : `, ${event.trigger}`})` : '';
      return `${moved}${auto}${why}`;
    }
    case 'reopened':
      return `reopened ${lane(event.from)} → ${lane(event.to)}: ${event.reason} — ask: ${event.ask.text}${
        event.attachments === undefined ? '' : ` — with ${attachmentsPhrase(event.attachments)}`
      }`;
    case 'note':
      return `note: ${event.text}`;
    case 'clarified':
      return `clarified: ${event.text}`;
    case 'linked':
      return `linked ${event.field}: ${event.value}`;
    case 'assigned':
      return `assigned ${event.from === null ? 'nobody' : names(event.from)} → ${event.to === null ? 'nobody' : names(event.to)}`;
    case 'blocked':
      return `blocked: ${event.reason}`;
    case 'unblocked':
      return `unblocked${event.reason === null ? '' : `: ${event.reason}`}`;
    case 'dropped':
      return `dropped: ${event.reason}`;
    default:
      return event.type;
  }
}

// ─── Accounts/Runtimes: the logins the warden may choose between (today's `core/inventory.ts`) ──────────────────────
export interface CoreAccount {
  readonly id: string;
  readonly agent: string;
  readonly mode: 'auto' | 'interactive';
  readonly available: boolean;
  readonly [key: string]: any;
}
export interface AccountInventoryPort {
  accounts(): Promise<readonly CoreAccount[]>;
}
/** The accounts that may take unattended work: the auto lane, minus anything declared down. */
export function selectableAutoAccounts(accounts: readonly CoreAccount[]): readonly CoreAccount[] {
  return accounts.filter(account => account.mode === 'auto' && account.available);
}

// ─── Ferrets: a background job that keeps a move from going ahead (today's `migrate/agent-jobs.ts`) ─────────────────
export interface AgentJob {
  readonly pid: number;
  readonly command: string;
  readonly age?: string;
}
export * from './foreign-pack.ts';
