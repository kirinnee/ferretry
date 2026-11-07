/**
 * Updates' wire (§2.1), copied from today's `packages/protocol/src/lib/{daemon-update,version-skew}.ts`. Harness
 * updates are the harness plugins' (`/v1/<harness>/update`, design §1.4). The full `GET /v1/daemon/update` view
 * (install method, plan, check, job) is copied by the port with the code that builds it; the contract carries what
 * others and the app read.
 */
import { InstantSchema, NonNegativeIntegerSchema } from '@ferretry/std';
import { z } from 'zod';

/** A semver release number. */
export const VersionSchema = z
  .string()
  .regex(
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u,
  );
export type Version = z.infer<typeof VersionSchema>;

/** How often the checker asks for a newer release. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How long a restarted daemon has to answer health before the update is rolled back. */
export const UPDATE_HEALTH_TIMEOUT_MS = 30_000;
/** The signing context of a daemon release's signature. */
export const DAEMON_RELEASE_SIGNATURE_CONTEXT = 'ferretry-daemon-release-v1\n';

/** `POST /v1/daemon/update`: the version the person saw and agreed to, now or once no ferret is mid-turn. */
export const DaemonUpdateStartRequestSchema = z.strictObject({
  target: VersionSchema,
  when: z.enum(['now', 'when-idle']),
});
export type DaemonUpdateStartRequest = z.infer<typeof DaemonUpdateStartRequestSchema>;

/** `PATCH /v1/daemon/update/settings`. */
export const DaemonUpdateSettingsPatchSchema = z.strictObject({ autoInstall: z.boolean() });
export type DaemonUpdateSettingsPatch = z.infer<typeof DaemonUpdateSettingsPatchSchema>;

export const DAEMON_UPDATE_CODES = {
  inProgress: 'update_in_progress',
  notAvailable: 'update_not_available',
  notSelfUpdatable: 'update_not_self_updatable',
  staleTarget: 'update_stale_target',
} as const;

export const UpdateOutcomeSchema = z.enum(['succeeded', 'rolled-back', 'failed']);

/** What the app's "behind" notice and `fy doctor` read through the port: this daemon against the newest release. */
export const UpdateStatusSchema = z.strictObject({
  current: VersionSchema,
  /** The newest release known; absent until a check succeeded. */
  latest: VersionSchema.optional(),
  available: z.boolean(),
  autoInstall: z.boolean(),
  midTurn: NonNegativeIntegerSchema,
  checkedAt: InstantSchema.optional(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

/** `config/updates.yaml`. Installing unasked is off unless the owner turned it on. */
export const UpdatesConfigSchema = z.strictObject({ autoInstall: z.boolean().default(false) });
export type UpdatesConfig = z.infer<typeof UpdatesConfigSchema>;

/** Turning on automatic installs lets the machine run new code unasked: a loosening the owner confirms. */
export function updatesLoosens(before: UpdatesConfig | undefined, after: UpdatesConfig): readonly string[] {
  return after.autoInstall && before?.autoInstall !== true ? ['updates install automatically when idle'] : [];
}
