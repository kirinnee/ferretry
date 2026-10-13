import { describe, it } from 'bun:test';
import { type CapabilityGrants, DAEMON_CAPABILITIES, GrantsViewSchema } from '@ferretry/protocol';
import should from 'should';
import type { CapabilityPresentation } from '../../../src/lib/api/capability.ts';
import {
  CapabilityGrantService,
  DEFAULT_CAPABILITY_GRANTS,
  type GrantAuditEntry,
  GrantError,
} from '../../../src/lib/grants/index.ts';

const NOW = 1_700_000_000_000;

interface World {
  readonly service: CapabilityGrantService;
  readonly audit: GrantAuditEntry[];
  written(): CapabilityGrants | undefined;
}

function world(
  options: { grants?: CapabilityGrants; broken?: boolean; auditFails?: boolean; clientName?: string } = {},
): World {
  let recorded = options.grants ?? DEFAULT_CAPABILITY_GRANTS;
  let written: CapabilityGrants | undefined;
  const audit: GrantAuditEntry[] = [];
  const service = new CapabilityGrantService({
    document: {
      read: async () => {
        if (options.broken === true) throw new Error('the grant document is not readable');
        return recorded;
      },
      written: async () => (options.grants === undefined ? [] : ['browser']),
      write: async next => {
        written = next;
        recorded = next;
      },
    },
    clock: { nowMs: () => NOW },
    audit: {
      record: async entry => {
        if (options.auditFails === true) throw new Error('the audit journal is full');
        audit.push(entry);
      },
      recent: async limit => ({ entries: [...audit].reverse().slice(0, limit), unreadable: 2, truncated: true }),
    },
    clientName: options.clientName ?? 'fy',
  });
  return { service, audit, written: () => written };
}

async function ready(options: Parameters<typeof world>[0] = {}): Promise<World> {
  const built = world(options);
  await built.service.refresh();
  return built;
}

/** A paired phone across the relay that has NOT confirmed with its passkey. */
const remote: CapabilityPresentation = { loopback: false, adminToken: false, actor: 'device:phone-1', stepUp: false };
/** The same phone after a passkey step-up. */
const steppedUp: CapabilityPresentation = { ...remote, stepUp: true };
/** The host's command line: arrived on the host and holding the admin token. */
const host: CapabilityPresentation = { loopback: true, adminToken: true, actor: 'admin-cli', stepUp: false };
/** A browser that carried the host proof — on the machine, with a DEVICE credential. */
const localBrowser: CapabilityPresentation = {
  loopback: true,
  adminToken: false,
  actor: 'device:this-browser',
  stepUp: false,
};
/** A remote warden: governed, proves no device, so it can never step up. */
const remoteWarden: CapabilityPresentation = { loopback: false, adminToken: true, actor: 'warden', stepUp: false };

async function failure(promise: Promise<unknown>): Promise<GrantError> {
  const raised = await promise.then(() => undefined).catch((error: unknown) => error);
  should(raised).be.instanceof(GrantError);
  return raised as GrantError;
}

describe('reading the operator decision', () => {
  it('should refuse every governed capability until the decision has been read', () => {
    // A service that has never read its document does not know what it may allow.
    // Arrange
    const { service } = world();

    // Act + Assert
    should(service.enforced()).be.undefined();
    should(service.decide({ capability: 'terminal', axis: 'use' }, steppedUp)).deepEqual({
      allowed: false,
      refusal: 'undetermined',
    });
  });

  it('should raise, and stop enforcing anything, when the document cannot be read', async () => {
    // Damaged state is not empty state.
    // Arrange
    const { service } = world({ broken: true });

    // Act
    const raised = await failure(service.refresh());

    // Assert
    should(raised.failure).equal('unavailable');
    should(raised.name).equal('GrantError');
    should(raised.message).match(/could not read its capability grants.*the grant document is not readable/u);
    should(service.enforced()).be.undefined();
    should(service.decide({ capability: 'fleet', axis: 'use' }, steppedUp).refusal).equal('undetermined');
    // The host is unaffected: it is not governed by this layer at all.
    should(service.decide({ capability: 'fleet', axis: 'use' }, host).allowed).be.true();
  });

  it('should stringify a thrown non-error rather than losing it', async () => {
    // Arrange
    const service = new CapabilityGrantService({
      document: {
        read: () => Promise.reject('disk on fire'),
        written: async () => [],
        write: async () => undefined,
      },
      clock: { nowMs: () => NOW },
      audit: { record: async () => undefined, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
      clientName: 'fy',
    });

    // Act
    const raised = await failure(service.refresh());

    // Assert
    should(raised.message).match(/disk on fire$/u);
  });

  it('should enforce what it read once refreshed', async () => {
    // Arrange
    const shut = { ...DEFAULT_CAPABILITY_GRANTS, warden: { use: false, configure: false } };
    const { service } = await ready({ grants: shut });

    // Act + Assert
    should(service.enforced()).deepEqual(shut);
    should(service.decide({ capability: 'warden', axis: 'use' }, steppedUp).refusal).equal('not-granted');
    should(service.decide({ capability: 'fleet', axis: 'use' }, remote).refusal).equal('granted');
  });
});

describe('the decision for each kind of caller', () => {
  it('should ask a governed caller for a step-up on configure and on the dangerous uses only', async () => {
    // Arrange
    const { service } = await ready();

    // Act + Assert
    should(service.decide({ capability: 'fleet', axis: 'use' }, remote).refusal).equal('granted');
    should(service.decide({ capability: 'terminal', axis: 'use' }, remote).refusal).equal('step-up-required');
    should(service.decide({ capability: 'fleet', axis: 'configure' }, remote).refusal).equal('step-up-required');
    should(service.decide({ capability: 'terminal', axis: 'use' }, steppedUp).refusal).equal('granted');
    should(service.decide({ capability: 'fleet', axis: 'configure' }, steppedUp).refusal).equal('granted');
  });

  it('should leave the host command line and a host-proven local browser ungoverned', async () => {
    // Arrange
    const shut = Object.fromEntries(
      DAEMON_CAPABILITIES.map(capability => [capability, { use: false, configure: false }]),
    ) as CapabilityGrants;
    const { service } = await ready({ grants: shut });

    // Act + Assert
    for (const caller of [host, localBrowser]) {
      for (const capability of DAEMON_CAPABILITIES) {
        should(service.decide({ capability, axis: 'configure' }, caller)).deepEqual({
          allowed: true,
          refusal: 'granted',
        });
      }
    }
  });

  it('should keep a remote warden governed even holding the admin token, and never stepped up', async () => {
    // Arrange
    const { service } = await ready();

    // Act + Assert
    should(service.decide({ capability: 'warden', axis: 'use' }, remoteWarden).allowed).be.true();
    should(service.decide({ capability: 'warden', axis: 'configure' }, remoteWarden).refusal).equal(
      'step-up-required',
    );
    should(service.view(remoteWarden)).containDeep({ governed: true, hostLocal: false, steppedUp: false });
  });
});

describe('the grant view a UI reads', () => {
  it('should report every capability with both axes, the document underneath, and each reason', async () => {
    // Arrange
    const { service } = await ready({ grants: { ...DEFAULT_CAPABILITY_GRANTS, browser: { use: false, configure: false } } });

    // Act
    const view = service.view(remote);

    // Assert
    should(GrantsViewSchema.parse(view)).deepEqual(view);
    should(Object.keys(view).sort()).deepEqual(['capabilities', 'governed', 'hostLocal', 'steppedUp']);
    should(view).containDeep({ governed: true, hostLocal: false, steppedUp: false });
    should(view.capabilities.map(row => row.capability)).deepEqual([...DAEMON_CAPABILITIES]);
    should(view.capabilities.find(row => row.capability === 'browser')).deepEqual({
      capability: 'browser',
      use: false,
      configure: false,
      granted: { use: false, configure: false },
      useRefusal: 'not-granted',
      configureRefusal: 'not-granted',
      mayGrant: false,
      origin: 'config file',
    });
    should(view.capabilities.find(row => row.capability === 'fleet')).deepEqual({
      capability: 'fleet',
      use: true,
      configure: false,
      granted: { use: true, configure: true },
      useRefusal: 'granted',
      configureRefusal: 'step-up-required',
      mayGrant: false,
      origin: 'default',
    });
  });

  it('should report a stepped-up remote caller as stepped up, and its configure axes as allowed', async () => {
    // Arrange
    const { service } = await ready();

    // Act
    const view = service.view(steppedUp);

    // Assert
    should(view).containDeep({ governed: true, hostLocal: false, steppedUp: true });
    for (const row of view.capabilities) {
      should(row).containDeep({ use: true, configure: true, useRefusal: 'granted', configureRefusal: 'granted' });
      should(row.mayGrant).be.false();
    }
  });

  it('should report the host as ungoverned, host-local and able to widen', async () => {
    // Arrange
    const { service } = await ready();

    // Act
    const view = service.view(localBrowser);

    // Assert
    should(view).containDeep({ governed: false, hostLocal: true, steppedUp: false });
    for (const row of view.capabilities) should(row.mayGrant).be.true();
  });

  it('should report an undetermined document as both axes shut', () => {
    // Arrange
    const { service } = world();

    // Act
    const view = service.view(steppedUp);

    // Assert
    for (const row of view.capabilities) {
      should(row).containDeep({
        use: false,
        configure: false,
        granted: { use: false, configure: false },
        useRefusal: 'undetermined',
        configureRefusal: 'undetermined',
      });
    }
  });

  it('should say nothing about any password', async () => {
    // Arrange
    const { service } = await ready();

    // Act
    const said = JSON.stringify(service.view(remote));

    // Assert
    should(said).not.match(/password|unlock/iu);
  });
});

describe('changing the grants', () => {
  it('should refuse to change grants it could not read, before anything else', async () => {
    // `unavailable` comes first: even a widening remote patch is told the daemon has no answer.
    // Arrange
    const { service, written } = world({ broken: true });
    await service.refresh().catch(() => undefined);

    // Act
    const raised = await failure(service.patch({ fleet: { use: true } }, remote));

    // Assert
    should(raised.failure).equal('unavailable');
    should(raised.message).match(/will not change them/u);
    should(written()).be.undefined();
  });

  it('should refuse a remote widening even with a step-up, naming the host command', async () => {
    // Widening is a local act. No step-up buys it.
    // Arrange
    const { service, written, audit } = await ready({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: true, configure: false } },
    });

    // Act
    const raised = await failure(service.patch({ terminal: { configure: true } }, steppedUp));

    // Assert
    should(raised.failure).equal('forbidden');
    should(raised.message).containEql('terminal.configure can only be turned on from the machine itself');
    should(raised.message).containEql('`fy daemon config set terminal --configure`');
    should(written()).be.undefined();
    should(audit).be.empty();
  });

  it('should check widening BEFORE configure permission and the step-up', async () => {
    // Arrange — the caller holds neither configure on the capability nor a step-up.
    const { service } = await ready({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, warden: { use: false, configure: false } },
    });

    // Act
    const raised = await failure(service.patch({ warden: { use: true } }, remote));

    // Assert
    should(raised.failure).equal('forbidden');
    should(raised.message).containEql('warden.use can only be turned on from the machine itself');
    should(raised.message).containEql('`fy daemon config set warden --use`');
  });

  it('should refuse the WHOLE patch when it both widens and narrows', async () => {
    // Arrange
    const { service, written } = await ready({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, browser: { use: false, configure: false } },
    });

    // Act
    const raised = await failure(service.patch({ browser: { use: true }, fleet: { configure: false } }, steppedUp));

    // Assert
    should(raised.failure).equal('forbidden');
    should(written()).be.undefined();
    should(service.enforced()?.fleet).deepEqual({ use: true, configure: true });
  });

  it('should refuse a governed narrowing of a capability it holds no configure on', async () => {
    // A UI the operator excluded from warden configuration cannot quietly rewrite the warden grant.
    // Arrange
    const { service, written } = await ready({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, warden: { use: true, configure: false } },
    });

    // Act
    const raised = await failure(service.patch({ warden: { use: false } }, steppedUp));

    // Assert
    should(raised.failure).equal('forbidden');
    should(raised.message).equal(
      'the operator of this machine has not granted the UI permission to change the warden grant',
    );
    should(written()).be.undefined();
  });

  it('should refuse a governed narrowing of a capability it holds no use on', async () => {
    // Arrange
    const { service } = await ready({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, filesystem: { use: false, configure: true } },
    });

    // Act
    const raised = await failure(service.patch({ filesystem: { configure: false } }, steppedUp));

    // Assert
    should(raised.failure).equal('forbidden');
    should(raised.message).containEql('change the filesystem grant');
  });

  it('should check configure permission BEFORE the step-up', async () => {
    // Arrange
    const { service } = await ready({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, warden: { use: true, configure: false } },
    });

    // Act
    const raised = await failure(service.patch({ warden: { use: false } }, remote));

    // Assert
    should(raised.failure).equal('forbidden');
  });

  it('should ask a governed caller to step up before it narrows', async () => {
    // Narrowing is itself a configure act.
    // Arrange
    const { service, written, audit } = await ready();

    // Act
    const raised = await failure(service.patch({ terminal: { use: false } }, remote));

    // Assert
    should(raised.failure).equal('step-up-required');
    should(raised.message).equal('changing these grants needs a passkey confirmation from this device.');
    should(raised.message).not.match(/password|unlock/iu);
    should(written()).be.undefined();
    should(audit).be.empty();
  });

  it('should let a stepped-up governed caller narrow, write it, audit it and answer with the new view', async () => {
    // Arrange
    const { service, written, audit } = await ready();

    // Act
    const view = await service.patch({ terminal: { use: false, configure: false } }, steppedUp);

    // Assert
    should(written()?.terminal).deepEqual({ use: false, configure: false });
    should(audit).deepEqual([
      {
        actor: 'device:phone-1',
        changes: ['terminal.use=off', 'terminal.configure=off'],
        at: new Date(NOW).toISOString(),
      },
    ]);
    should(view.capabilities.find(row => row.capability === 'terminal')?.useRefusal).equal('not-granted');
    should(view.steppedUp).be.true();
  });

  it('should let the host widen with no step-up at all', async () => {
    // Arrange
    const { service, written, audit } = await ready({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, pairing: { use: false, configure: false } },
    });

    // Act
    await service.patch({ pairing: { use: true, configure: true } }, host);

    // Assert
    should(written()?.pairing).deepEqual({ use: true, configure: true });
    should(audit[0]).containDeep({ actor: 'admin-cli', changes: ['pairing.use=on', 'pairing.configure=on'] });
  });

  it('should let a host-proven local browser widen too, because locality is the boundary', async () => {
    // Arrange
    const { service, written } = await ready({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, browser: { use: false, configure: false } },
    });

    // Act
    await service.patch({ browser: { use: true } }, localBrowser);

    // Assert
    should(written()?.browser).deepEqual({ use: true, configure: false });
  });

  it('should take effect immediately, with no restart', async () => {
    // Arrange
    const { service } = await ready();

    // Act
    await service.patch({ fleet: { use: false } }, steppedUp);

    // Assert
    should(service.decide({ capability: 'fleet', axis: 'use' }, steppedUp).refusal).equal('not-granted');
  });

  it('should audit a patch that changed nothing with no changes', async () => {
    // Arrange
    const { service, audit } = await ready();

    // Act
    await service.patch({ fleet: { use: true } }, steppedUp);

    // Assert
    should(audit[0]?.changes).be.empty();
  });

  it('should not swallow an audit that failed after the write', async () => {
    // Arrange
    const { service, written } = await ready({ auditFails: true });

    // Act
    const raised = await service
      .patch({ fleet: { use: false } }, steppedUp)
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert
    should(raised).be.instanceof(Error);
    should((raised as Error).message).equal('the audit journal is full');
    should(written()?.fleet.use).be.false();
  });
});

describe('the history of changes', () => {
  it('should report the recorded changes, newest first, with the reading damage', async () => {
    // Arrange
    const { service } = await ready();
    await service.patch({ fleet: { use: false } }, steppedUp);
    await service.patch({ warden: { configure: false } }, host);

    // Act
    const history = await service.history(1);

    // Assert
    should(history).deepEqual({
      entries: [{ at: new Date(NOW).toISOString(), actor: 'admin-cli', changes: ['warden.configure=off'] }],
      unreadable: 2,
      truncated: true,
    });
  });
});

describe('where a caller stands, for a route that must add one step', () => {
  it('should tell an ungoverned caller it is ungoverned, and answer every axis as granted', async () => {
    // Arrange
    const { service } = await ready();

    // Act
    const governance = service.governance(localBrowser);

    // Assert
    should(governance.governed).be.false();
    should(governance.decide({ capability: 'terminal', axis: 'configure' })).deepEqual({
      allowed: true,
      refusal: 'granted',
    });
  });

  it('should answer for an axis its own route never demanded, and never disagree with the boundary', async () => {
    // Arrange
    const { service } = await ready({ grants: { ...DEFAULT_CAPABILITY_GRANTS, warden: { use: true, configure: false } } });

    // Act
    const governance = service.governance(remote);

    // Assert
    should(governance.governed).be.true();
    for (const capability of DAEMON_CAPABILITIES) {
      for (const axis of ['use', 'configure'] as const) {
        should(governance.decide({ capability, axis })).deepEqual(service.decide({ capability, axis }, remote));
      }
    }
  });
});

describe('the sentence a refusal carries', () => {
  it('should compose it here, with the client name this layer was built with', () => {
    // Arrange
    const { service } = world({ clientName: 'ferretry' });

    // Act + Assert
    should(service.explain({ capability: 'fleet', axis: 'use' }, 'granted')).be.undefined();
    should(service.explain({ capability: 'fleet', axis: 'use' }, 'not-granted')).containEql(
      '`ferretry daemon config set fleet --use`',
    );
    should(service.explain({ capability: 'fleet', axis: 'configure' }, 'step-up-required')).equal(
      'changing the settings for the agent fleet needs a passkey confirmation from this device.',
    );
  });

  it('should name the client in a widening refusal', async () => {
    // Arrange
    const { service } = await ready({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, fleet: { use: false, configure: true } },
      clientName: 'ferretry',
    });

    // Act
    const raised = await failure(service.patch({ fleet: { use: true } }, steppedUp));

    // Assert
    should(raised.message).containEql('`ferretry daemon config set fleet --use`');
  });
});
