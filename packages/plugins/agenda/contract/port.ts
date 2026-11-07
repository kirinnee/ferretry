import { defineEvent, definePort } from '@ferretry/kernel/contract';
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type {
  AgendaClearAgentsResult,
  AgendaMode,
  AgendaOpenPage,
  AgendaOpenQuery,
  BuzzKind,
  DaemonAgenda,
} from './wire.ts';
import { BuzzKindSchema } from './wire.ts';

/** What other plugins and the app read through Agenda. Asks themselves are Asks'; this is the view over them. */
export interface AgendaApi {
  open(query: AgendaOpenQuery): Promise<AgendaOpenPage>;
  daemonAgenda(): Promise<DaemonAgenda>;
  mode(ferret: FerretId): Promise<AgendaMode>;
  setMode(ferret: FerretId, enabled: boolean): Promise<AgendaMode>;
  clearAgents(options: { readonly dryRun: boolean }): Promise<AgendaClearAgentsResult>;
  /** Buzzes once per `key`; a second call with the same key is a no-op. Resolves whether it buzzed. */
  buzz(key: string, kind: BuzzKind, message: { readonly title: string; readonly body: string }): Promise<boolean>;
}
export const AgendaPort = definePort<AgendaApi>('agenda');

export const AgendaModeChanged = defineEvent(
  'agenda.mode-changed',
  z.strictObject({ ferret: FerretIdSchema, enabled: z.boolean() }),
);
export const AgendaBuzzed = defineEvent(
  'agenda.buzzed',
  z.strictObject({ key: z.string().min(1), kind: BuzzKindSchema, at: InstantSchema }),
);
