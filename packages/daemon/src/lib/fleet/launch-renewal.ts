/**
 * Giving an account's credential its chance to renew at the moment somebody starts an agent on it.
 *
 * ## Why here, and nowhere near a timer
 *
 * A provider access token expires in hours; the refresh token beside it lives for weeks. Ferretry has
 * been passive about the gap — an expired credential renews itself the first time some session happens
 * to run, and nothing renews it if nobody runs one. Making that ACTIVE is what `FleetTokenRefreshService`
 * is for, and the only question left is who is allowed to ask it.
 *
 * The answer is: somebody who is here. A renewal rewrites shared credential state on this host, and the
 * harness writes its own store by temp-file-and-rename — so a writer racing it "would lose, and would
 * lose SILENTLY" (`packages/fleet/src/lib/credential-seed.ts`). That is not a cost argument; a refresh is
 * an auth call rather than inference. It is that a rotation nobody is watching can leave an identity
 * needing a browser approval, with no person present to be told. So renewal is ATTENDED ONLY: a person
 * runs a command, or a person starts a session. This module is the second of those, and the unattended
 * usage pass in `lib/fleet-refresh/` is deliberately not the third.
 *
 * ## It can delay a launch and it can never refuse one
 *
 * Every ending is a value. A configuration that will not parse, a manifest nobody wrote, a store that
 * throws, an identity whose accounts disagree about how they authenticate — each of those is a sentence
 * and then a launch that proceeds exactly as it would have. A renewal that could not happen is not a
 * reason not to start a session, and a session refused by the thing that was trying to make it work is
 * the worst outcome available here.
 *
 * Delay is a different question from refusal, and the honest answer is that this adds almost none. The
 * renewal fires on ONE credential state — an access token that has aged out with a refresh token still
 * beside it — and in exactly that state the harness would have to make the same OAuth round trip itself
 * on its first turn. So the wait is moved earlier rather than added, and it is bounded by the deadline
 * `ProcessFleetTokenRefreshPort` already owns. A second deadline here would be a second opinion about a
 * bound that is not this module's to hold.
 *
 * ## The gate is not here
 *
 * {@link FleetTokenRenewal} re-reads the chosen home before it spawns anything and refuses everything
 * that is not positively expired-with-a-way-back, and it is the only door to the port. This resolves
 * WHICH identity is about to be launched and hands over the readings; it never decides that a rotation is
 * safe. Two modules do not get opinions about a single-use refresh token. In particular the survey below
 * only CHOOSES — the fresh read inside the service is what authorises the spawn — so a launch that
 * surveyed a moment too early costs a wasted decision and never a spent token.
 *
 * ## What it deliberately does NOT do
 *
 * It does not fan the renewed credential out to the identity's other homes. A rotating refresh token is
 * consumed by whoever uses it first, so the siblings holding a clone of it still hold one that is spent —
 * and copying the new one to them is the login pass's sync, which already owns credential copying and
 * already knows the temp-file-and-rename hazard. Doing it from a launch path would be a second writer for
 * the same files, which is the exact shape the attended rule exists to avoid.
 *
 * Nothing here reads credential material. It reads classifications through {@link FleetIdentityService}'s
 * survey, exactly as every other reader does, and the material stays behind that boundary in an adapter.
 */

import {
  buildFleetIdentities,
  type FleetConfig,
  type FleetIdentity,
  type FleetIdentityStatus,
  type FleetManifest,
  type FleetTokenRefreshResult,
  type FleetTokenRenewal,
  wrapperNameOf,
} from '@ferretry/fleet';

/**
 * Renewing whatever account is about to run, before its pane starts.
 *
 * A PORT, so both launch paths depend on the decision rather than on the fleet. It takes the absolute
 * published wrapper a session record already carries — the same value {@link AccountLaunchEnvironment}
 * takes — because an account is never located by a string somebody assembled.
 *
 * It answers nothing. A launcher cannot branch on this, which is the point: there is no outcome here that
 * a launch is allowed to act on.
 */
export interface AccountLaunchRenewal {
  beforeLaunch(wrapper: string): Promise<void>;
}

/** The two reads this needs of the fleet — the same pair the browser's sign-in surface reads. */
export interface LaunchRenewalFleetReader {
  config(): Promise<FleetConfig>;
  accounts(): Promise<FleetManifest>;
}

/** Reading what each home in one identity holds. Satisfied by `FleetIdentityService`. */
export interface LaunchRenewalSurvey {
  surveyOne(identity: FleetIdentity): Promise<FleetIdentityStatus>;
}

/**
 * Where a launch-time renewal says what it did.
 *
 * Structurally the daemon's own journal, so a host reads these in the same stream as everything else it
 * is told. Which sentences are worth a person's attention is decided HERE rather than by the caller: a
 * composition root that had to choose between `step` and `state` would be making a product decision in
 * the one file no ledger covers.
 */
export interface LaunchRenewalNotices {
  step(name: string, detail?: string): void;
  state(message: string): void;
}

export interface FleetLaunchRenewalDeps {
  readonly fleet: LaunchRenewalFleetReader;
  readonly identities: LaunchRenewalSurvey;
  readonly renewal: FleetTokenRenewal;
  /** Absent means a launch renews in silence, which is what a daemon with no journal gets. */
  readonly notices?: LaunchRenewalNotices;
}

/**
 * What one launch-time renewal decided, before anybody phrases it.
 *
 * `not-a-fleet-account` is an ordinary outcome and not a failure: a session may legally run an executable
 * this daemon does not publish, and having no opinion about it is the correct one to have.
 */
export type LaunchRenewalOutcome =
  | { readonly kind: 'not-a-fleet-account' }
  | { readonly kind: 'undecided'; readonly reason: string }
  | { readonly kind: 'decided'; readonly result: FleetTokenRefreshResult };

/**
 * Which outcomes a person must read, and which are the ordinary case.
 *
 * Silence is the default and it is load-bearing: a renewal refusing to spend a rotating refresh token is
 * the gate working, and a line saying so on every session start would bury the one line that matters
 * under the ones that never do. So the four nothings are silent, a rotation that happened is a milestone,
 * and only an ending somebody has to act on is raised.
 *
 * Annotated over the whole status union rather than defaulted, so an eighth status is a compile error
 * here instead of a state that silently says nothing.
 */
const NOTICE: Readonly<Record<FleetTokenRefreshResult['status'], 'step' | 'state' | 'silent'>> = {
  renewed: 'step',
  // The identity really does need a person now: a harness whose rotation is refused clears its own
  // tokens, so the agent about to start has nothing to authenticate with.
  failed: 'state',
  // The harness command could not be found, which is `docs/harness-paths.md`'s whole subject.
  unavailable: 'state',
  // A home could not be read, so whether this account can authenticate is unknown rather than fine.
  indeterminate: 'state',
  'not-expired': 'silent',
  'not-renewable': 'silent',
  'not-required': 'silent',
};

/** The sentence one decided outcome is worth, in the terms of the credential and never its contents. */
function launchRenewalSentence(result: FleetTokenRefreshResult): string {
  const where = result.accountId === undefined ? '' : ` (${result.accountId})`;
  const because = result.reason === undefined ? '' : ` — ${result.reason}`;
  return `${result.identity}${where}: ${result.status}${because}`;
}

/**
 * Renews the account a pane is about to run, or says why it did not.
 *
 * Reads the PUBLISHED MANIFEST joined with the declared configuration, per launch, for the reason
 * `launch-environment.ts` gives for reading the manifest: it is regenerated by the same apply that writes
 * the wrappers, so it cannot describe an account differently from the wrapper that will run. The
 * configuration is needed beside it because an identity is a declaration — which accounts share one
 * provider login is a thing somebody wrote down, not a thing a manifest knows.
 *
 * An executable this daemon does not publish costs one lookup in a list and no credential read at all,
 * so a fleet nobody uses pays nothing for this being wired.
 */
export class FleetLaunchRenewal implements AccountLaunchRenewal {
  constructor(private readonly deps: FleetLaunchRenewalDeps) {}

  async beforeLaunch(wrapper: string): Promise<void> {
    this.#say(await this.decide(wrapper));
  }

  /**
   * The whole decision as a value, which is what makes the launch path's silence testable.
   *
   * Exposed rather than private because {@link beforeLaunch} answers nothing on purpose: a test that
   * could only observe this through a notices fake would be pinning the phrasing instead of the decision.
   */
  async decide(wrapper: string): Promise<LaunchRenewalOutcome> {
    let identity: FleetIdentity | undefined;
    try {
      const [config, manifest] = [await this.deps.fleet.config(), await this.deps.fleet.accounts()];
      const name = wrapperNameOf(wrapper);
      identity = buildFleetIdentities(config, manifest).find(candidate =>
        candidate.members.some(member => member.wrapper === wrapper || wrapperNameOf(member.wrapper) === name),
      );
    } catch (error) {
      return { kind: 'undecided', reason: reasonOf(error, 'this host’s fleet could not be read') };
    }
    if (identity === undefined) return { kind: 'not-a-fleet-account' };

    try {
      const status = await this.deps.identities.surveyOne(identity);
      return { kind: 'decided', result: await this.deps.renewal.renew(identity, status.members) };
    } catch (error) {
      return {
        kind: 'undecided',
        reason: reasonOf(error, `“${identity.key}” could not be renewed before this launch`),
      };
    }
  }

  #say(outcome: LaunchRenewalOutcome): void {
    const notices = this.deps.notices;
    if (notices === undefined || outcome.kind === 'not-a-fleet-account') return;
    if (outcome.kind === 'undecided') {
      notices.state(`no credential was renewed before this session started — ${outcome.reason}`);
      return;
    }
    const sentence = launchRenewalSentence(outcome.result);
    if (NOTICE[outcome.result.status] === 'step') notices.step('credential renewed', sentence);
    if (NOTICE[outcome.result.status] === 'state') notices.state(`a session started on ${sentence}`);
  }
}

function reasonOf(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : String(error).trim();
  return message === '' ? fallback : message;
}
