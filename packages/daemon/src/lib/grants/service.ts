import {
  type CapabilityGrantView,
  DAEMON_CAPABILITIES,
  type DaemonCapability,
  type GrantAuditView,
  type GrantRefusal,
  type GrantsPatch,
  type GrantsView,
} from '@ferretry/protocol';
import type {
  CallerGovernance,
  CapabilityDemand,
  CapabilityGuard,
  CapabilityPresentation,
  GrantDecision,
} from '../api/capability.ts';
import {
  applyGrantPatch,
  decideCapability,
  describeGrantRefusal,
  type GrantEvaluation,
  grantChanges,
  isGovernedCaller,
  patchedCapabilities,
  widenedBy,
} from './policy.ts';
import type { EnforcedGrants, GrantAuditPort, GrantClock, GrantDocumentPort } from './types.ts';

/** A refusal the grant subsystem raises, in a taxonomy the mount turns into a status. */
export type GrantFailure = 'invalid' | 'forbidden' | 'step-up-required' | 'unavailable';

export class GrantError extends Error {
  constructor(
    readonly failure: GrantFailure,
    message: string,
  ) {
    super(message);
    this.name = 'GrantError';
  }
}

/** Everything the subsystem is built from, so nothing is reached for at the point of use. */
export interface CapabilityGrantDeps {
  readonly document: GrantDocumentPort;
  readonly clock: GrantClock;
  /** Where a change is recorded so it is visible after the fact rather than only in its effect. */
  readonly audit: GrantAuditPort;
  /** The command a human actually types, so a refusal names it rather than inventing one. */
  readonly clientName: string;
  /**
   * Told every time the enforced answer moves — a change, a refresh, a failed refresh — so streams
   * authorized under the old answer are asked again instead of running on it.
   */
  readonly changed?: () => void;
}

/**
 * The operator's per-capability decision, enforced.
 *
 * ## IT HOLDS ITS ANSWER IN MEMORY, AND THAT IS THE DESIGN
 *
 * Authorization runs in front of every request and every socket upgrade. A boundary that read a file
 * to answer would put a filesystem — and a new failure mode — in front of a question that must always
 * have an answer, so the decision is loaded once, refreshed when it changes, and read synchronously.
 * `refresh` is the only path that moves it, and a refresh that FAILS sets the answer to
 * "undetermined" rather than leaving a stale one in place: a daemon that no longer knows what it may
 * do must stop doing it, not carry on from the last thing it remembered.
 *
 * A CHANGE MADE HERE TAKES EFFECT IMMEDIATELY. `patch` writes the document and moves the in-memory
 * answer in the same call, so the next request is decided by the new one — no restart. A document
 * edited by HAND behind the daemon's back is the case that needs a restart, and the command line says
 * so at the moment somebody does it.
 *
 * ## NOTHING HERE CAN WIDEN A CREDENTIAL
 *
 * `decide` is consulted only after the route's scope check has already passed, and every branch
 * either keeps that answer or removes it. A device token cannot reach an `admin` route because a
 * grant says `use: true`, and no document an operator writes can make it.
 *
 * ## THE STEP-UP IS READ, NEVER HELD
 *
 * Whether a caller has confirmed with its passkey arrives on the presentation, computed by the
 * dispatcher from the session's proven device. This subsystem holds no confirmation state of its own,
 * so there is exactly one record of who stepped up and it lives with the step-up service.
 */
export class CapabilityGrantService implements CapabilityGuard {
  /** `undefined` until the first successful refresh, and again after a failed one. */
  private grants: EnforcedGrants;
  /** Which capabilities the document actually names, for the provenance column. */
  private writtenDown: readonly DaemonCapability[] = [];

  constructor(private readonly deps: CapabilityGrantDeps) {}

  /**
   * Re-reads the operator's decision.
   *
   * Called at boot before the daemon serves, and after every change. It swallows nothing: a failure
   * clears the enforced grants, so the very next request is refused with `undetermined` and a message
   * naming the document, rather than being served from a decision that may no longer be true.
   */
  async refresh(): Promise<void> {
    try {
      const [grants, written] = await Promise.all([this.deps.document.read(), this.deps.document.written()]);
      this.grants = grants;
      this.writtenDown = written;
      this.deps.changed?.();
    } catch (error) {
      this.grants = undefined;
      this.deps.changed?.();
      throw new GrantError(
        'unavailable',
        `this daemon could not read its capability grants, so every governed capability is refused: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The synchronous answer the authorization boundary asks for. */
  decide(demand: CapabilityDemand, presentation: CapabilityPresentation): GrantDecision {
    return decideCapability(demand, this.evaluate(presentation));
  }

  /**
   * Where this caller stands relative to the gate, for a handler that must honour or render it.
   *
   * Built from the SAME `evaluate` every decision above uses, so a route that asks one more question
   * can never be reasoning about a different caller than the one the boundary just allowed.
   */
  governance(presentation: CapabilityPresentation): CallerGovernance {
    const evaluation = this.evaluate(presentation);
    return {
      governed: evaluation.governed,
      // The SAME evaluation, captured once, rather than a fresh one per question, so one request is
      // always described as one caller.
      decide: demand => decideCapability(demand, evaluation),
    };
  }

  /** The sentence that goes with a refusal, composed here because only this layer knows the client
   *  name a person actually types. */
  explain(demand: CapabilityDemand, refusal: GrantRefusal): string | undefined {
    return describeGrantRefusal(demand, refusal, this.deps.clientName);
  }

  /**
   * What the UI is told, so it can explain a limit BEFORE somebody clicks into it.
   *
   * It reports both axes per capability, what the operator's document says underneath, and the reason
   * each answer reads the way it does — `step-up-required` among them, so a panel can offer the
   * passkey confirmation beside the control it unlocks.
   */
  view(presentation: CapabilityPresentation): GrantsView {
    const evaluation = this.evaluate(presentation);
    const capabilities: readonly CapabilityGrantView[] = DAEMON_CAPABILITIES.map(capability =>
      this.capabilityView(capability, evaluation),
    );
    return {
      capabilities,
      // Projected, never re-derived: it is the same `isGovernedCaller` answer every decision above was
      // made with, so a view can never disagree with the enforcement it describes.
      governed: evaluation.governed,
      hostLocal: evaluation.hostLocal,
      steppedUp: evaluation.stepUp,
    };
  }

  /**
   * Records a change to the grants themselves.
   *
   * ## WIDENING IS A LOCAL ACT. THERE IS NO REMOTE PATH TO IT AT ALL.
   *
   * A governed caller may never turn a capability ON — not with a step-up, not ever. Locality is the
   * boundary, and this is the whole of it: a stolen phone cannot grant itself anything, so the worst it
   * can do is narrow the machine's own permissions.
   *
   * IT IS A ONE-WAY DOOR AND THAT IS SAID OUT LOUD. An operator who switches something off from a
   * phone cannot switch it back on from that phone — the refusal names the remedy exactly, and the
   * grant view carries `mayGrant` so a UI can say so BEFORE somebody walks through the door rather
   * than after.
   *
   * ## THE PATCH IS ALL OR NOTHING
   *
   * A patch that widens one capability and narrows another is refused ENTIRELY. Applying the safe half
   * would leave the operator with a machine in a state they did not ask for and did not get told
   * about, which is worse than either outcome — and the refusal would be indistinguishable from a
   * total one. `next` is computed before anything is written, so this holds by construction.
   *
   * ## NARROWING
   *
   * A governed caller must already hold `configure` on every capability it names — so a UI the
   * operator has excluded from warden configuration cannot quietly rewrite the warden grant — and,
   * because changing a grant is itself a configure act, it must hold a live passkey step-up. One touch
   * on the device already in hand; revoking still never needs the host.
   */
  async patch(patch: GrantsPatch, presentation: CapabilityPresentation): Promise<GrantsView> {
    const current = this.grants;
    if (current === undefined)
      throw new GrantError(
        'unavailable',
        'this daemon could not read its capability grants, so it will not change them',
      );
    const evaluation = this.evaluate(presentation);
    const next = applyGrantPatch(current, patch);
    const widened = widenedBy(current, next);
    // Computed over the WHOLE patch and refused before anything is written, so a mixed patch takes
    // neither half. A step-up is deliberately not consulted: it cannot buy this.
    if (widened.length > 0 && !evaluation.hostLocal)
      throw new GrantError(
        'forbidden',
        `${widened.join(', ')} can only be turned on from the machine itself — no remote caller may. Run \`${this.deps.clientName} daemon config set ${widened[0]?.split('.')[0] ?? 'fleet'} --${widened[0]?.split('.')[1] ?? 'use'}\` on the host.`,
      );
    if (evaluation.governed) {
      for (const capability of patchedCapabilities(patch)) {
        const grant = current[capability];
        if (!grant.use || !grant.configure)
          throw new GrantError(
            'forbidden',
            `the operator of this machine has not granted the UI permission to change the ${capability} grant`,
          );
      }
      if (!evaluation.stepUp)
        throw new GrantError(
          'step-up-required',
          'changing these grants needs a passkey confirmation from this device.',
        );
    }
    const changes = grantChanges(current, next);
    await this.deps.document.write(next);
    this.grants = next;
    this.deps.changed?.();
    // AFTER the write, so a record can never claim a change that did not reach the document. A failing
    // audit is not swallowed: a change nobody can see afterwards is the state this exists to prevent.
    await this.deps.audit.record({
      actor: presentation.actor,
      changes,
      at: new Date(this.deps.clock.nowMs()).toISOString(),
    });
    return this.view(presentation);
  }

  /**
   * Who changed what, most recent first.
   *
   * IT IS NOT GATED ON THE GRANTS IT REPORTS. A caller refused a capability is exactly the caller who
   * needs to know when and by whom it was refused — gating the history behind the decision would make
   * the answer unreachable to the only person asking the question. It discloses actors and axes; no
   * credential has ever been written to that file.
   */
  async history(limit: number): Promise<GrantAuditView> {
    const reading = await this.deps.audit.recent(limit);
    return {
      entries: reading.entries.map(entry => ({ at: entry.at, actor: entry.actor, changes: entry.changes })),
      unreadable: reading.unreadable,
      truncated: reading.truncated,
    };
  }

  /** What the daemon's own reports may say about this subsystem. */
  enforced(): EnforcedGrants {
    return this.grants;
  }

  private capabilityView(capability: DaemonCapability, evaluation: GrantEvaluation): CapabilityGrantView {
    const use = decideCapability({ capability, axis: 'use' }, evaluation);
    const configure = decideCapability({ capability, axis: 'configure' }, evaluation);
    // The document's own answer travels beside the effective one so a UI can distinguish "you said no"
    // from "you said yes but this device has not confirmed" without inferring it from two booleans. An
    // undetermined document reports both axes shut, which is what is being enforced.
    const granted = evaluation.grants?.[capability] ?? { use: false, configure: false };
    return {
      capability,
      use: use.allowed,
      configure: configure.allowed,
      granted,
      ...(evaluation.device === undefined || evaluation.device === null
        ? {}
        : { deviceGranted: evaluation.device[capability] }),
      useRefusal: use.refusal,
      configureRefusal: configure.refusal,
      // LOCALITY decides it, and nothing else can: no caller off this host ever widens.
      mayGrant: evaluation.hostLocal,
      origin: this.writtenDown.includes(capability) ? 'config file' : 'default',
    };
  }

  /** The facts every question reads, gathered in ONE place so `decide`, `view` and `patch` agree. */
  private evaluate(presentation: CapabilityPresentation): GrantEvaluation {
    return {
      grants: this.grants,
      governed: isGovernedCaller({ loopback: presentation.loopback }),
      hostLocal: presentation.loopback,
      stepUp: presentation.stepUp,
      // Only a GOVERNED caller is narrowed by its device: a browser that arrived on the host is not.
      ...(isGovernedCaller({ loopback: presentation.loopback }) && presentation.deviceGrants !== undefined
        ? { device: presentation.deviceGrants }
        : {}),
    };
  }
}
