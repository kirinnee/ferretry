import { z } from 'zod';

/**
 * AGENDA MODE, PER FERRET: whether a ferret is told to keep an agenda of asks for the owner (`fy ask …`). ON for a new
 * ferret unless the machine default is off; every ferret is told the short notify rule either way. A running ferret
 * takes the change at its next launch.
 *
 * `GET /v1/ferrets/:ferretId/agenda-mode` reads it; `PATCH` of the same path switches it.
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

/** What switching it did: the ferret, the switch as it now stands, whether a restart is needed, said in words. */
export const SessionAgendaModePatchResultSchema = z.strictObject({
  ferret: z.string().min(1),
  enabled: z.boolean(),
  restartRequired: z.boolean(),
  note: z.string().min(1),
});
export type SessionAgendaModePatchResult = z.infer<typeof SessionAgendaModePatchResultSchema>;
