import { z } from 'zod';
import { SessionViewSchema } from './session.ts';

/**
 * AGENDA MODE, PER FERRET (docs/notifications.md § Agenda mode): whether a ferret is told to keep an agenda of
 * items for the owner (`fy agenda …`). OFF by default; every ferret is told the short notify rule either way.
 * Switched exactly like Pack mode and Hypermedia — `config.agenda` on the session document, which every surface
 * reads — and a running ferret takes the change at its next launch.
 *
 * `GET /v1/sessions/:sessionId/agenda-mode` reads it; `PATCH` of the same path switches it.
 */
export const SessionAgendaModePatchSchema = z.strictObject({ enabled: z.boolean() });
export type SessionAgendaModePatch = z.infer<typeof SessionAgendaModePatchSchema>;

/** The switch as it reads now: what `GET` answers. */
export const SessionAgendaModeSchema = z.strictObject({
  enabled: z.boolean(),
  /** A running ferret was instructed at launch, so a change reaches it only at its next launch. */
  restartRequired: z.boolean(),
  note: z.string().min(1),
});
export type SessionAgendaMode = z.infer<typeof SessionAgendaModeSchema>;

/**
 * What switching it did, in the shape of Hypermedia's and Pack's: the switched `SessionView`, whether a restart is
 * needed for it to take effect (nothing is sent to a running ferret), and that said in words.
 */
export const SessionAgendaModePatchResultSchema = z.strictObject({
  view: SessionViewSchema,
  restartRequired: z.boolean(),
  note: z.string().min(1),
});
export type SessionAgendaModePatchResult = z.infer<typeof SessionAgendaModePatchResultSchema>;
