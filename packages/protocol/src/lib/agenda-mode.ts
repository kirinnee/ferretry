import { z } from 'zod';

/**
 * AGENDA MODE, PER FERRET (docs/notifications.md § Agenda mode): whether a ferret is told to keep an agenda of
 * items for the owner (`fy agenda …`). OFF by default; every ferret is told the short notify rule either way.
 * Switched exactly like Pack mode and Hypermedia: a running ferret takes the change at its next launch.
 *
 * `GET /v1/sessions/:sessionId/agenda-mode` reads it; `PATCH` of the same path switches it.
 */
export const SessionAgendaModePatchSchema = z.strictObject({ enabled: z.boolean() });
export type SessionAgendaModePatch = z.infer<typeof SessionAgendaModePatchSchema>;

/** The switch as it reads now; after a PATCH, what switching did, said in words. */
export const SessionAgendaModeSchema = z.strictObject({
  enabled: z.boolean(),
  /** A running ferret was instructed at launch, so a change reaches it only at its next launch. */
  restartRequired: z.boolean(),
  note: z.string().min(1),
});
export type SessionAgendaMode = z.infer<typeof SessionAgendaModeSchema>;
