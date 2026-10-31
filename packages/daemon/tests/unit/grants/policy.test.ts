import { describe, it } from 'bun:test';
import {
  type CapabilityAxis,
  type CapabilityGrants,
  DAEMON_CAPABILITIES,
  type DaemonCapability,
  GRANT_REFUSALS,
  type GrantRefusal,
} from '@ferretry/protocol';
import should from 'should';
import {
  applyGrantPatch,
  capabilityNoun,
  DEFAULT_CAPABILITY_GRANTS,
  decideCapability,
  demandNeedsStepUp,
  describeDemand,
  describeGrantRefusal,
  type GrantEvaluation,
  grantChanges,
  isGovernedCaller,
  patchedCapabilities,
  widenedBy,
} from '../../../src/lib/grants/index.ts';
import { tunnelApiRequest } from '../../../src/lib/relay/tunnel.ts';

const AXES: readonly CapabilityAxis[] = ['use', 'configure'];

/** A remote caller holding a step-up against the permissive defaults, unless a case says otherwise. */
const evaluation = (overrides: Partial<GrantEvaluation> = {}): GrantEvaluation => ({
  grants: DEFAULT_CAPABILITY_GRANTS,
  governed: true,
  hostLocal: false,
  stepUp: true,
  ...overrides,
});

/** Every capability shut on both axes. */
const SHUT: CapabilityGrants = Object.fromEntries(
  DAEMON_CAPABILITIES.map(capability => [capability, { use: false, configure: false }]),
) as CapabilityGrants;

/** The defaults with ONE capability's grant replaced. */
const grantsWith = (capability: DaemonCapability, grant: { use: boolean; configure: boolean }): CapabilityGrants => ({
  ...DEFAULT_CAPABILITY_GRANTS,
  [capability]: grant,
});

/**
 * THE SPECIFICATION, written out rather than derived from the code under test: every `configure`, and
 * the `use` of the four capabilities whose ordinary use reaches past the daemon.
 */
const NEEDS_STEP_UP: Readonly<Record<DaemonCapability, Readonly<Record<CapabilityAxis, boolean>>>> = {
  fleet: { use: false, configure: true },
  terminal: { use: true, configure: true },
  browser: { use: true, configure: true },
  filesystem: { use: false, configure: true },
  warden: { use: false, configure: true },
  pairing: { use: true, configure: true },
  secrets: { use: true, configure: true },
  sharing: { use: true, configure: true },
};

/** The grant document states a matrix row can find a capability in. */
const DOCUMENT_STATES = [
  { label: 'both axes granted', grant: { use: true, configure: true } },
  { label: 'use granted, configure refused', grant: { use: true, configure: false } },
  { label: 'use refused, configure granted', grant: { use: false, configure: true } },
  { label: 'both axes refused', grant: { use: false, configure: false } },
] as const;

/** What a governed caller is answered, stated case by case from the contract. */
function expectedGoverned(
  capability: DaemonCapability,
  axis: CapabilityAxis,
  grant: { use: boolean; configure: boolean },
  stepUp: boolean,
): GrantRefusal {
  if (!grant.use) return 'not-granted';
  if (axis === 'configure' && !grant.configure) return 'not-granted';
  if (NEEDS_STEP_UP[capability][axis] && !stepUp) return 'step-up-required';
  return 'granted';
}

describe('who the grants govern', () => {
  it('should govern exactly the callers that did not arrive on the host', () => {
    // Act + Assert
    should(isGovernedCaller({ loopback: false })).be.true();
    should(isGovernedCaller({ loopback: true })).be.false();
  });

  it('should leave a host-proven local browser ungoverned, whatever the document says', () => {
    // A browser that carried the host proof (`arrivedOnHost`) is somebody at the machine, who already
    // has the machine. Neither a grant nor a step-up is asked of it — not even for the terminal.
    // Arrange
    const local = evaluation({
      grants: SHUT,
      governed: isGovernedCaller({ loopback: true }),
      hostLocal: true,
      stepUp: false,
    });

    // Act + Assert
    for (const capability of DAEMON_CAPABILITIES) {
      for (const axis of AXES) {
        should(decideCapability({ capability, axis }, local)).deepEqual({ allowed: true, refusal: 'granted' });
      }
    }
  });

  it('should treat a RELAYED request as remote even though the relay terminates on this host', () => {
    // THE TEST THAT DECIDES WHETHER THIS DESIGN IS SOUND RATHER THAN A HOLE.
    //
    // The rendezvous socket is opened by the daemon and terminates inside this very host, so a check
    // that read a peer address, a `Host` header or a URL would see loopback for a phone on the other
    // side of the world and hand it the machine. The carrier answers instead, and it answers `false`.
    // Arrange — a relayed request that presents every loopback-looking signal it possibly could.
    const relayed = tunnelApiRequest(
      {
        method: 'POST',
        path: '/v1/fleet/apply',
        headers: {
          host: '127.0.0.1:7432',
          'x-forwarded-for': '127.0.0.1',
          origin: 'http://localhost:7432',
        },
        query: [['token', 'anything']],
      },
      { deviceId: 'fy_device_id_phone', appSession: 'app-one' },
      'rendezvous-session',
    );

    // Act
    const governed = isGovernedCaller({ loopback: relayed.loopback });

    // Assert — the address it claims changes nothing, and without a step-up it cannot configure.
    should(relayed.loopback).be.false();
    should(governed).be.true();
    should(
      decideCapability(
        { capability: 'fleet', axis: 'configure' },
        evaluation({ governed, hostLocal: relayed.loopback, stepUp: false }),
      ),
    ).deepEqual({ allowed: false, refusal: 'step-up-required' });
  });

  it('should keep a remote warden governed, and it can never step up', () => {
    // A warden is not a paired browser session: it proves no device, so the dispatcher's witness has
    // nothing to look up and `stepUp` is always false. It may watch — `warden.use` and `fleet.use` need
    // no step-up — but every configure and every dangerous use is refused, however the document reads.
    // Arrange
    const warden = evaluation({ governed: isGovernedCaller({ loopback: false }), stepUp: false });

    // Act + Assert
    should(decideCapability({ capability: 'warden', axis: 'use' }, warden)).deepEqual({
      allowed: true,
      refusal: 'granted',
    });
    should(decideCapability({ capability: 'fleet', axis: 'use' }, warden)).deepEqual({
      allowed: true,
      refusal: 'granted',
    });
    for (const capability of DAEMON_CAPABILITIES) {
      should(decideCapability({ capability, axis: 'configure' }, warden)).deepEqual({
        allowed: false,
        refusal: 'step-up-required',
      });
    }
    for (const capability of ['terminal', 'browser', 'pairing'] as const) {
      should(decideCapability({ capability, axis: 'use' }, warden).refusal).equal('step-up-required');
    }
  });
});

describe('which demands need a step-up', () => {
  it('should need one for every configure and for the use of terminal, browser, pairing and secrets only', () => {
    // Act + Assert
    for (const capability of DAEMON_CAPABILITIES) {
      for (const axis of AXES) {
        should(demandNeedsStepUp({ capability, axis })).equal(NEEDS_STEP_UP[capability][axis]);
      }
    }
  });
});

describe('the per-capability decision matrix', () => {
  it('should default every axis of every capability to enabled', () => {
    // Permissive by default, restrictive by choice.
    // Assert
    for (const capability of DAEMON_CAPABILITIES) {
      should(DEFAULT_CAPABILITY_GRANTS[capability]).deepEqual({ use: true, configure: true });
    }
  });

  for (const capability of DAEMON_CAPABILITIES) {
    for (const axis of AXES) {
      for (const state of DOCUMENT_STATES) {
        for (const stepUp of [true, false]) {
          const governedRefusal = expectedGoverned(capability, axis, state.grant, stepUp);
          it(`${capability}.${axis}, ${state.label}, ${stepUp ? 'stepped up' : 'no step-up'}: governed → ${governedRefusal}, ungoverned → granted`, () => {
            // Arrange
            const grants = grantsWith(capability, state.grant);

            // Act
            const governed = decideCapability({ capability, axis }, evaluation({ grants, stepUp }));
            const ungoverned = decideCapability(
              { capability, axis },
              evaluation({ grants, stepUp, governed: false, hostLocal: true }),
            );

            // Assert
            // A step-up is only SPENT by an act that leaned on one: allowed AND the demand needs it.
            const leanedOnStepUp = governedRefusal === 'granted' && NEEDS_STEP_UP[capability][axis] && stepUp;
            should(governed).deepEqual({
              allowed: governedRefusal === 'granted',
              refusal: governedRefusal,
              ...(leanedOnStepUp ? { steppedUp: true } : {}),
            });
            should(ungoverned).deepEqual({ allowed: true, refusal: 'granted' });
          });
        }
      }

      for (const stepUp of [true, false]) {
        it(`${capability}.${axis}, undetermined document, ${stepUp ? 'stepped up' : 'no step-up'}: governed → undetermined, ungoverned → granted`, () => {
          // Permissive DEFAULTS settle what silence means, never what damage means — and a step-up
          // cannot buy back an answer the daemon no longer has.
          // Act
          const governed = decideCapability({ capability, axis }, evaluation({ grants: undefined, stepUp }));
          const ungoverned = decideCapability(
            { capability, axis },
            evaluation({ grants: undefined, stepUp, governed: false, hostLocal: true }),
          );

          // Assert
          should(governed).deepEqual({ allowed: false, refusal: 'undetermined' });
          should(ungoverned).deepEqual({ allowed: true, refusal: 'granted' });
        });
      }
    }
  }

  it('should mark a decision steppedUp only when an allowed act leaned on the caller’s step-up', () => {
    // The boundary spends a single-use step-up on exactly this mark, so it must never ride a refusal, an
    // ungoverned caller, or a demand that needed no step-up (a held one is not consumed by those).
    for (const capability of DAEMON_CAPABILITIES) {
      for (const axis of AXES) {
        for (const stepUp of [true, false]) {
          const demand = { capability, axis };
          const needs = NEEDS_STEP_UP[capability][axis];
          should(decideCapability(demand, evaluation({ stepUp })).steppedUp === true).equal(needs && stepUp);
          should(decideCapability(demand, evaluation({ stepUp, governed: false })).steppedUp).be.undefined();
          should(decideCapability(demand, evaluation({ stepUp, grants: undefined })).steppedUp).be.undefined();
          should(decideCapability(demand, evaluation({ stepUp, grants: SHUT })).steppedUp).be.undefined();
        }
      }
    }
  });

  it('should reach every refusal the protocol declares, and no other', () => {
    // The matrix above is only exhaustive if it produces the whole vocabulary.
    // Arrange
    const seen = new Set<GrantRefusal>();

    // Act
    for (const capability of DAEMON_CAPABILITIES) {
      for (const axis of AXES) {
        for (const grants of [undefined, DEFAULT_CAPABILITY_GRANTS, SHUT]) {
          for (const stepUp of [true, false]) {
            for (const governed of [true, false]) {
              for (const device of [undefined, DEFAULT_CAPABILITY_GRANTS, SHUT]) {
                const context = evaluation({ grants, stepUp, governed, ...(device === undefined ? {} : { device }) });
                seen.add(decideCapability({ capability, axis }, context).refusal);
              }
            }
          }
        }
      }
    }

    // Assert
    should([...seen].sort()).deepEqual([...GRANT_REFUSALS].sort());
  });

  it('should never turn a refused capability into a served one for a governed caller', () => {
    // The invariant: a capability the operator switched off is refused whatever else is true.
    // Act + Assert
    for (const capability of DAEMON_CAPABILITIES) {
      for (const axis of AXES) {
        for (const stepUp of [true, false]) {
          for (const hostLocal of [true, false]) {
            should(
              decideCapability({ capability, axis }, evaluation({ grants: SHUT, stepUp, hostLocal })).allowed,
            ).be.false();
          }
        }
      }
    }
  });
});

describe('what a refused caller is told', () => {
  it('should explain nothing for a demand that was granted', () => {
    // Act + Assert
    for (const capability of DAEMON_CAPABILITIES) {
      for (const axis of AXES) {
        should(describeGrantRefusal({ capability, axis }, 'granted', 'fy')).be.undefined();
      }
    }
  });

  it('should name a runnable host command for not-granted and undetermined, with the right flag', () => {
    // A denial that says only "forbidden" is a dead end.
    // Act + Assert
    for (const capability of DAEMON_CAPABILITIES) {
      const use = describeGrantRefusal({ capability, axis: 'use' }, 'not-granted', 'fy') ?? '';
      const configure = describeGrantRefusal({ capability, axis: 'configure' }, 'not-granted', 'fy') ?? '';
      const undetermined = describeGrantRefusal({ capability, axis: 'use' }, 'undetermined', 'fy') ?? '';
      should(use).containEql(`\`fy daemon config set ${capability} --use\``);
      should(use).containEql(capabilityNoun(capability));
      should(configure).containEql(`\`fy daemon config set ${capability} --configure\``);
      should(configure).match(/change the settings/u);
      should(undetermined).containEql('`fy daemon config`');
      should(undetermined).containEql(capabilityNoun(capability));
    }
  });

  it('should thread the client name rather than inventing one', () => {
    // Act
    const said = describeGrantRefusal({ capability: 'fleet', axis: 'use' }, 'not-granted', 'ferretry') ?? '';

    // Assert
    should(said).containEql('`ferretry daemon config set fleet --use`');
    should(said).not.containEql('`fy ');
  });

  it('should say step-up-required as one sentence that asks for the passkey and names no password', () => {
    // Act
    for (const capability of DAEMON_CAPABILITIES) {
      for (const axis of AXES) {
        const said = describeGrantRefusal({ capability, axis }, 'step-up-required', 'fy') ?? '';

        // Assert — one sentence: a single terminal full stop and nothing after it.
        should(said).match(/^[^.]+\.$/u);
        should(said).containEql('passkey confirmation from this device');
        should(said).containEql(capabilityNoun(capability));
        should(said).not.match(/password|unlock/iu);
        // It is no decision the operator made, so it must not read as one.
        should(said).not.match(/has not granted/u);
      }
    }
    should(describeGrantRefusal({ capability: 'terminal', axis: 'use' }, 'step-up-required', 'fy')).equal(
      'using session terminals needs a passkey confirmation from this device.',
    );
    should(describeGrantRefusal({ capability: 'fleet', axis: 'configure' }, 'step-up-required', 'fy')).equal(
      'changing the settings for the agent fleet needs a passkey confirmation from this device.',
    );
  });

  it('should name each capability as a person reads it', () => {
    // Assert
    should(DAEMON_CAPABILITIES.map(capabilityNoun)).deepEqual([
      'the agent fleet',
      'session terminals',
      'the browser',
      'the project filesystem',
      'fleet supervision',
      'device pairing',
      'the secret store',
      'catalog sharing',
    ]);
    should(describeDemand('fleet', 'configure')).equal('fleet.configure');
  });
});

describe('applying a change', () => {
  it('should leave every axis the patch does not name exactly as it was', () => {
    // A stale tab restating answers it never looked at must not revert a decision made in another.
    // Arrange
    const current = { ...DEFAULT_CAPABILITY_GRANTS, warden: { use: true, configure: false } };

    // Act
    const next = applyGrantPatch(current, { terminal: { configure: false }, browser: { use: false } });

    // Assert
    should(next.warden).deepEqual({ use: true, configure: false });
    should(next.terminal).deepEqual({ use: true, configure: false });
    should(next.browser).deepEqual({ use: false, configure: true });
    should(next.fleet).deepEqual({ use: true, configure: true });
    should(patchedCapabilities({ terminal: { configure: false }, browser: { use: false } })).deepEqual([
      'terminal',
      'browser',
    ]);
    should(patchedCapabilities({})).be.empty();
  });

  it('should report which axes a change turns ON, and none for a change that only revokes', () => {
    // Widening is host-only; narrowing is the one thing a remote caller may do.
    // Act
    const widened = widenedBy(grantsWith('fleet', { use: false, configure: false }), DEFAULT_CAPABILITY_GRANTS);
    const configureOnly = widenedBy(grantsWith('pairing', { use: true, configure: false }), DEFAULT_CAPABILITY_GRANTS);
    const narrowed = widenedBy(DEFAULT_CAPABILITY_GRANTS, SHUT);

    // Assert
    should(widened).deepEqual(['fleet.use', 'fleet.configure']);
    should(configureOnly).deepEqual(['pairing.configure']);
    should(narrowed).be.empty();
  });

  it('should record every axis a change moves, in report order', () => {
    // Act + Assert
    should(grantChanges(DEFAULT_CAPABILITY_GRANTS, grantsWith('fleet', { use: false, configure: false }))).deepEqual([
      'fleet.use=off',
      'fleet.configure=off',
    ]);
    should(grantChanges(grantsWith('warden', { use: true, configure: false }), DEFAULT_CAPABILITY_GRANTS)).deepEqual([
      'warden.configure=on',
    ]);
    should(grantChanges(DEFAULT_CAPABILITY_GRANTS, DEFAULT_CAPABILITY_GRANTS)).be.empty();
  });
});
