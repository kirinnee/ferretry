/**
 * W2-c: whether a running ferret is on the settings a relaunch would give it (`GET /v1/ferrets/:ferretId/relaunch-settings`,
 * R-0169; today's `SessionLaunchService.drift` over `FileLaunchSettingsDigest`, `fyd.ts:8020`).
 *
 * RULING #27 Q9: the harness that launched the ferret is asked through its additive `Harness.launchSettings`, and
 * Ferrets reads no harness file. Today read the login's wrapper and its fixed settings file itself; in 5.0 those are
 * the harness plugin's own (its home, its configuration), so the plugin records what it launched under and compares.
 *
 * The answer is today's shape and words, field for field: `{ current, reasons }`, where `reasons` names a KIND of drift
 * (`settings`) and never a value. Every failure is today's "nothing to say" (`current: true`, no reasons): a harness
 * that is gone, offers no comparison, throws, does not answer within {@link RELAUNCH_SETTINGS_TIMEOUT_MS} (on the kernel
 * clock, so a hung state read never hangs the route), or answers anything but a well-formed `drifted`. What it threw is
 * dropped unread, so no sentence of a harness's (a path, a setting) can reach the response.
 *
 * GAP(relaunch): today's second reason, `arguments` (the daemon-owned launch argv a relaunch would build differs from
 * the recorded one), is not computed: in 5.0 the harness builds the argv from the `LaunchSpec` at each launch and
 * Ferrets records none to compare, so this read never answers `arguments`.
 *
 * GAP(relaunch): nothing Runtimes or the Vault supply is compared either: a change of the runtime, the profile or the
 * credential's environment between a launch and now is not detected (today's wrapper digest covered them, and showed
 * them as `settings` drift). It waits for those plugins to offer a fingerprint the harness can record.
 */
import type { SessionRelaunchSettings } from '../lib/protocol/session.ts';
import type { FerretId, Harness, HarnessKey } from '../../contract/index.ts';
import type { SessionId } from '../lib/session-id.ts';

/** Today's `UNKNOWN`: nothing to say, so no Restart is offered on this read's account. */
const NOTHING_TO_SAY: SessionRelaunchSettings = { current: true, reasons: [] };
const DRIFTED: SessionRelaunchSettings = { current: false, reasons: ['settings'] };

/** How long a harness has to answer; past it the read says nothing, as for any other failure. */
export const RELAUNCH_SETTINGS_TIMEOUT_MS = 10_000;

export interface RelaunchSettingsDeps {
  /** The harness key the ferret's record names, or nothing when the registry holds no such ferret. */
  readonly harnessOf: (ferret: FerretId) => HarnessKey | undefined;
  /** The harness serving that key now, or nothing when its plugin is not loaded. */
  readonly harness: (key: HarnessKey) => Harness | undefined;
  /** Runs `fire` once after `delayMs` (the kernel clock), and answers how to cancel it: the bound on the answer. */
  readonly after: (delayMs: number, fire: () => void) => () => void;
}

/** The move module's `launch` need: only its `drift` read is asked of it. */
export interface RelaunchDrift {
  drift(id: SessionId): Promise<SessionRelaunchSettings>;
}

export function relaunchSettings(deps: RelaunchSettingsDeps): RelaunchDrift {
  return {
    drift: async id => {
      const ferret = id as unknown as FerretId;
      const key = deps.harnessOf(ferret);
      const harness = key === undefined ? undefined : deps.harness(key);
      if (harness?.launchSettings === undefined) return NOTHING_TO_SAY;
      const answer = await within(deps, async () => await harness.launchSettings?.(ferret));
      return isDrifted(answer) ? DRIFTED : NOTHING_TO_SAY;
    },
  };
}

/**
 * The harness's answer, or nothing when it throws or is late. Never rejects; the timer is cancelled as soon as the
 * answer settles, and a late answer or a late throw is dropped unread.
 */
async function within(deps: Pick<RelaunchSettingsDeps, 'after'>, ask: () => Promise<unknown>): Promise<unknown> {
  let cancel: (() => void) | undefined;
  const late = new Promise<undefined>(resolve => {
    cancel = deps.after(RELAUNCH_SETTINGS_TIMEOUT_MS, () => resolve(undefined));
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(ask)
        .catch(() => undefined),
      late,
    ]);
  } finally {
    cancel?.();
  }
}

/** Only a well-formed `drifted` says the process is on older settings; anything else claims nothing. */
function isDrifted(answer: unknown): boolean {
  return typeof answer === 'object' && answer !== null && (answer as { kind?: unknown }).kind === 'drifted';
}
