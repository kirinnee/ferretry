/**
 * Terminals' port (§2.3): the terminals a ferret holds, by id and title, for the screens and plugins that list them.
 * Never pane text: what a terminal shows leaves only through an act (`kernel.act`) or the masked viewer stream.
 */
import { defineEvent, definePort, type FerretId } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { type TerminalHoldersView, TerminalIdSchema, type TerminalView } from './wire.ts';

export interface TerminalsApi {
  /** The terminals one ferret holds. */
  of(ferret: FerretId): Promise<readonly TerminalView[]>;
  /** Who holds terminals across the machine, against its limit. */
  holders(): Promise<TerminalHoldersView>;
}

export const TerminalsPort = definePort<TerminalsApi>('terminals');

/** A terminal opened or closed, or a person took one over or handed it back. Read the port for the truth. */
export const TerminalChanged = defineEvent(
  'terminals.changed',
  z.strictObject({
    ferret: z.string().min(1),
    terminal: TerminalIdSchema,
    change: z.enum(['opened', 'closed', 'taken-over', 'handed-back', 'handed-over', 'asked']),
  }),
);
