/**
 * Updates' wire (§2.1), copied from today's `packages/protocol/src/lib/{daemon-update,harness-update,version-skew}.ts`.
 * The full `GET /v1/daemon/update` and `GET /v1/harnesses/update` views (install method, plan, check, job) are
 * copied by the port with the code that builds them; the contract carries what others and the app read.
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

/** The agent CLIs this machine updates (today's wire names). */
export const HarnessSchema = z.enum(['claude', 'codex']);
export type Harness = z.infer<typeof HarnessSchema>;

/** `POST /v1/harnesses/update`. */
export const HarnessUpdateStartRequestSchema = z.strictObject({
  harness: HarnessSchema,
  /** The version to install; absent is the newest the method offers. */
  target: VersionSchema.optional(),
  /** The person's explicit yes to going past the version Ferretry verified. */
  confirmUnverified: z.boolean().optional(),
});
export type HarnessUpdateStartRequest = z.infer<typeof HarnessUpdateStartRequestSchema>;

export const HARNESS_UPDATE_CODES = {
  unverified: 'harness_update_unverified',
  inProgress: 'harness_update_in_progress',
  notLocated: 'harness_update_not_located',
  notSelfUpdatable: 'harness_update_not_self_updatable',
  notTargetable: 'harness_update_not_targetable',
  notAvailable: 'harness_update_not_available',
} as const;

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
