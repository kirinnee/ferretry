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
 * that is gone, offers no comparison, throws, or answers anything but a well-formed `drifted`. What it threw is
 * dropped unread, so no sentence of a harness's (a path, a setting) can reach the response.
 *
 * GAP(relaunch): today's second reason, `arguments` (the daemon-owned launch argv a relaunch would build differs from
 * the recorded one), is not computed: in 5.0 the harness builds the argv from the `LaunchSpec` at each launch and
 * Ferrets records none to compare, so this read never answers `arguments`.
 */
import type { SessionRelaunchSettings } from '../lib/protocol/session.ts';
import type { FerretId, Harness, HarnessKey } from '../../contract/index.ts';
import type { SessionId } from '../lib/session-id.ts';

/** Today's `UNKNOWN`: nothing to say, so no Restart is offered on this read's account. */
const NOTHING_TO_SAY: SessionRelaunchSettings = { current: true, reasons: [] };
const DRIFTED: SessionRelaunchSettings = { current: false, reasons: ['settings'] };

export interface RelaunchSettingsDeps {
  /** The harness key the ferret's record names, or nothing when the registry holds no such ferret. */
  readonly harnessOf: (ferret: FerretId) => HarnessKey | undefined;
  /** The harness serving that key now, or nothing when its plugin is not loaded. */
  readonly harness: (key: HarnessKey) => Harness | undefined;
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
      const answer = await harness.launchSettings(ferret).catch(() => undefined);
      return isDrifted(answer) ? DRIFTED : NOTHING_TO_SAY;
    },
  };
}

/** Only a well-formed `drifted` says the process is on older settings; anything else claims nothing. */
function isDrifted(answer: unknown): boolean {
  return typeof answer === 'object' && answer !== null && (answer as { kind?: unknown }).kind === 'drifted';
}
