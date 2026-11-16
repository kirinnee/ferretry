import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { AgendaId } from './snapshot/agenda.ts';
import type { TaskRef } from './snapshot/board-refs.ts';

/**
 * The agenda's lineage and card context (docs/agenda.md § Sub-ferret agenda, § One ask per thing): what Asks cannot
 * know itself because another subsystem owns it. Ferrets knows who started whom; Board knows a session's focus card
 * and whether a card already asks the owner through its gate. Asks reads both lazily at each call.
 *
 * SECURITY PATH: lineage decides whether a sub-ferret's `fy agenda add` is refused, so each key has one named taker
 * (`takers`), and an answer that cannot be had reads as the SAFE side (an unknown ferret is refused, an unreadable
 * lineage is refused, an unreadable gate is asking).
 */

/** What the home rule reads of one session: its configuration document (the shape `AgendaHomes` reads). */
export interface AgendaContextSession {
  readonly id: string;
  readonly parent?: string;
  readonly origin?: 'human' | 'session' | 'warden';
  readonly mode: string;
  readonly projectId?: string;
  /** `config.updatedAt`: the recency the owner's latest interactive session is picked by. */
  readonly updatedAt: string;
  /** Whether the session still runs. Unknown reads as live. */
  readonly live?: boolean;
}

/** Ferrets' half (key `ferrets`): which sessions exist and who started whom. */
export interface AgendaFerretsContext {
  /** Whether the ferret exists. */
  has(ferret: string): Promise<boolean>;
  /** The ferret that started this one (`parent`); `undefined` for a lead or an unknown ferret. */
  leadOf(ferret: string): Promise<string | undefined>;
  /** What `fy send` takes to reach a ferret: its callsign when it has one, else its id. */
  addressOf(ferret: string): Promise<string>;
  /** One ferret's configuration as the home rule reads it; `undefined` for one that cannot be read. */
  get(ferret: string): Promise<AgendaContextSession | undefined>;
  /** Every ferret id. */
  all(): Promise<readonly string[]>;
}

/** Board's half (key `board`): a ferret's focus card and the gate's asks. */
export interface AgendaBoardContext {
  /** The card the ferret works on (`config.focusTask`); `null` for none. */
  focusOf(ferret: string): Promise<TaskRef | null>;
  /** Whether the card waits in the lane where released work is tried. */
  inToTest(task: TaskRef): Promise<boolean>;
  /** Where the card's gate already asks the owner (the item and the agenda it is on); `undefined` when it does not. */
  asking(task: TaskRef): Promise<{ readonly sessionId: string; readonly id: AgendaId } | undefined>;
}

export interface AgendaContextSources {
  readonly ferrets: AgendaFerretsContext;
  readonly board: AgendaBoardContext;
}

/** The two keys `agenda.context` is provided under. */
export const AGENDA_CONTEXT_KEYS = ['ferrets', 'board'] as const;

export const AgendaContext = defineHook('agenda.context', {
  mode: 'provide',
  key: z.enum(AGENDA_CONTEXT_KEYS),
  value: z.custom<AgendaFerretsContext | AgendaBoardContext>(),
  takers: ['ferrets', 'board'],
});
