/**
 * Updates' wire (§2.1): the routes' request bodies, what others read through the port and `config/updates.yaml`.
 * The view `GET /v1/daemon/update` answers lives in `view.ts`, the install method and plan in `install.ts`, the
 * release in `release.ts`. Harness updates are the harness plugins' (`/v1/<harness>/update`, design §1.4).
 */
import { InstantSchema, NonNegativeIntegerSchema } from '@ferretry/std';
import { z } from 'zod';
import { VersionSchema } from './version.ts';
import { DaemonUpdateViewSchema } from './view.ts';

/** How often the checker asks for a newer release. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How long a restarted daemon has to answer health before the update is rolled back. */
export const UPDATE_HEALTH_TIMEOUT_MS = 30_000;
/**
 * What a standalone release signature covers: this line, then the exact bytes of `checksums.txt`. The prefix is
 * domain separation: a signature over bare `checksums.txt` bytes would be a signature over whatever else those bytes
 * could be read as. `scripts/ci/sign-daemon-release.sh` reads this line from here.
 */
export const DAEMON_RELEASE_SIGNATURE_CONTEXT = 'ferretry-daemon-release-v1\n';

/** `POST /v1/daemon/update`: the version the person saw and agreed to, now or once no ferret is mid-turn. */
export const DaemonUpdateStartRequestSchema = z.strictObject({
  /** Refused when it is no longer the latest known. */
  target: VersionSchema,
  when: z.enum(['now', 'when-idle']),
});
export type DaemonUpdateStartRequest = z.infer<typeof DaemonUpdateStartRequestSchema>;

/** `PATCH /v1/daemon/update/settings`. */
export const DaemonUpdateSettingsPatchSchema = z.strictObject({ autoInstall: z.boolean() });
export type DaemonUpdateSettingsPatch = z.infer<typeof DaemonUpdateSettingsPatchSchema>;

/** Refusal codes the update routes answer with, so the app can say the right sentence. */
export const DAEMON_UPDATE_CODES = {
  inProgress: 'update_in_progress',
  notAvailable: 'update_not_available',
  notSelfUpdatable: 'update_not_self_updatable',
  staleTarget: 'update_stale_target',
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

/**
 * `config/updates.yaml`. Installing unasked is OFF unless the owner turned it on, and 5.0.0 ships with it off (§9.3):
 * the first release never installs a newer one by itself.
 */
export const UpdatesConfigSchema = z.strictObject({ autoInstall: z.boolean().default(false) });
export type UpdatesConfig = z.infer<typeof UpdatesConfigSchema>;

/** Turning on automatic installs lets the machine run new code unasked: a loosening the owner confirms. */
export function updatesLoosens(before: UpdatesConfig | undefined, after: UpdatesConfig): readonly string[] {
  return after.autoInstall && before?.autoInstall !== true ? ['updates install automatically when idle'] : [];
}

/**
 * `PATCH /v1/daemon/update/settings` answered `202` when the edit loosens (turns installing on): it waits for the
 * owner's confirmation and the setting stays as it was until then.
 */
export const DaemonUpdateSettingsHeldSchema = z.strictObject({
  held: z.array(z.string().min(1)).min(1),
  view: DaemonUpdateViewSchema,
});
export type DaemonUpdateSettingsHeld = z.infer<typeof DaemonUpdateSettingsHeldSchema>;

export const UPDATE_HOST_CODES = {
  hostUnavailable: 'update_host_unavailable',
  configUnavailable: 'update_config_unavailable',
  settingRefused: 'update_setting_refused',
} as const;
