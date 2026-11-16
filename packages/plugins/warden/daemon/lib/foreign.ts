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
const SessionTurnStateSchema = z.enum(['working', 'your-turn', 'needs-input']);
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
/** What an agent is called in a sentence a person reads: its first name when it has one, its title otherwise. */
export function agentSpokenName(ferret: { readonly teammate?: string; readonly name: string }): string {
  const callsign = (ferret.teammate ?? '').trim().toLowerCase();
  return callsign === '' ? ferret.name : displayAgentName(callsign);
}
/** Title-case a callsign for display: `hadi` → `Hadi`, `mary-jane` → `Mary-Jane`; a system callsign keeps its shape. */
export function displayAgentName(callsign: string): string {
  if (/^(warden|miner|guide)-[0-9a-f]{6}$/iu.test(callsign)) return displaySystemCallsign(callsign);
  return callsign
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}

// ─── Agenda/Asks: the limits and the words of one owner-facing notice (today's `protocol/agenda.ts`) ────────────────
export const MAX_AGENDA_SUBJECT_LENGTH = 240;
export const MAX_AGENDA_DETAIL_LENGTH = 2_048;
export const MAX_AGENDA_REASON_LENGTH = 1_024;
export const AGENDA_PUSH_TITLE_LENGTH = 40;
export const AGENDA_PUSH_BODY_LENGTH = 120;
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

// ─── Conversation: a message waiting in a ferret's queue — Conversation's own contract type, read, not restated ──────
export type { QueuedMessage } from '@ferretry/plugin-conversation/contract';

// ─── Accounts/Runtimes: the logins the warden may choose between (today's `core/inventory.ts`) ──────────────────────
export interface CoreAccount {
  readonly id: string;
  readonly agent: string;
  readonly mode: 'auto' | 'interactive';
  readonly available: boolean;
  readonly [key: string]: unknown;
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
