import { describe, it } from 'bun:test';
import { OWNER_ONLY_CODE, STEP_UP_ACTS, STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { deviceStanding, ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import type { ApiRequest, CallContext, FerretId } from '@ferretry/kernel/contract';
import { owner, testArrival } from '@ferretry/kernel/testing';
import should from 'should';
import {
  freshSubject,
  ownerActorOf,
  refusedAccountNames,
  refusedPageInput,
  refusedSecretWrite,
  spentSecretWrite,
} from '../../../../daemon/lib/http/grants.ts';

/**
 * The extra demands a route makes after its own, and who the owner is on a call: driven with Gate's test standings, the
 * way the real spine hands them to a handler.
 */

const request: ApiRequest = {
  method: 'GET',
  path: '/',
  query: new Map(),
  headers: new Map(),
  arrival: testArrival(owner()),
  text: async () => '',
};

const contextOf = (standing: ReturnType<typeof ownerStanding>): CallContext =>
  ({ request, params: new Map(), ...standing }) as CallContext;

type Governance = NonNullable<ReturnType<typeof ownerStanding>['governance']>;

/** A governed standing whose grants answer `decision` for every demand, recording what was asked. */
function governedBy(decision: ReturnType<Governance['decide']>, asked: unknown[] = []) {
  return {
    ...deviceStanding('phone-1'),
    governance: {
      governed: true,
      decide: (demand: unknown) => {
        asked.push(demand);
        return decision;
      },
    } as Governance,
  };
}

const bodyOf = (response: { readonly body: unknown }) =>
  JSON.parse(String(response.body)) as { error: string; code: string; demand?: unknown };

describe('ownerActorOf', () => {
  it('should name the machine for the admin token and the holder for a paired device', () => {
    should(ownerActorOf(contextOf(ownerStanding()))).eql({ kind: 'host' });
    should(ownerActorOf(contextOf(deviceStanding('phone-1')))).eql({ kind: 'device', deviceId: 'phone-1' });
  });

  it('should refuse a ferret in the act’s own words, whatever it claims', () => {
    const refused = (() => {
      try {
        ownerActorOf(contextOf(ferretStanding('F1' as FerretId)), 'reads the standing rules');
      } catch (error) {
        return error as { status: number; code: string; message: string };
      }
      return undefined;
    })();
    should(refused).match({ status: 403, code: OWNER_ONLY_CODE });
    should(refused?.message).containEql('reads the standing rules');
  });

  it('should word the default act when none is given', () => {
    const refused = (() => {
      try {
        ownerActorOf(contextOf(ferretStanding('F1' as FerretId)));
      } catch (error) {
        return error as { message: string };
      }
      return undefined;
    })();
    should(refused?.message).containEql('answers an input request');
  });
});

describe('the extra demands behind a route', () => {
  it('should allow the owner at the machine, who is ungoverned', () => {
    const context = contextOf(ownerStanding());
    should(refusedSecretWrite(context, 'approve pastes')).be.undefined();
    should(refusedPageInput(context)).be.undefined();
    should(refusedAccountNames(context)).be.undefined();
  });

  it('should refuse when the daemon cannot say whether the caller may, rather than allow', () => {
    // A paired device with no governance on its standing: the spine never derived one.
    const refused = refusedSecretWrite(contextOf(deviceStanding('phone-1')), 'approve pastes');
    should(refused?.status).equal(403);
    should(refused === undefined ? undefined : bodyOf(refused)).match({
      code: 'forbidden',
      error: 'this daemon cannot say whether this caller may approve pastes, so it is refusing',
    });
  });

  it('should ask for the capability and axis each demand needs', () => {
    const asked: unknown[] = [];
    const allowing = contextOf(governedBy({ allowed: true, refusal: 'granted' }, asked));
    should(refusedSecretWrite(allowing, 'a')).be.undefined();
    should(refusedPageInput(allowing, 'b')).be.undefined();
    should(refusedAccountNames(allowing, 'c')).be.undefined();
    should(asked).eql([
      { capability: 'secrets', axis: 'configure' },
      { capability: 'browser', axis: 'use' },
      { capability: 'secrets', axis: 'use' },
    ]);
  });

  it('should demand a passkey, naming the act, when the grant needs a step-up', () => {
    const refused = refusedSecretWrite(
      contextOf(governedBy({ allowed: false, refusal: 'step-up-required' })),
      'approve pastes into the secret store',
    );
    should(refused?.status).equal(403);
    should(refused === undefined ? undefined : bodyOf(refused)).eql({
      error: 'approve pastes into the secret store from this device needs a passkey confirmation',
      code: STEP_UP_REQUIRED_CODE,
      demand: { capability: 'secrets', axis: 'configure' },
    });
  });

  it('should refuse a device the grant was not given to, with the grant’s own code and the consequence', () => {
    const page = refusedPageInput(contextOf(governedBy({ allowed: false, refusal: 'device-not-granted' })));
    should(page?.status).equal(403);
    should(page === undefined ? undefined : bodyOf(page)).eql({
      error: 'this device may not allow a value into a page: that needs the browser permission',
      code: 'grant_device_not_granted',
    });
    const names = refusedAccountNames(contextOf(governedBy({ allowed: false, refusal: 'not-granted' })));
    should(names === undefined ? undefined : bodyOf(names)).eql({
      error: 'this device may not read the accounts a task plan names: that needs the secrets permission',
      code: 'grant_not_granted',
    });
    const secret = refusedSecretWrite(contextOf(governedBy({ allowed: false, refusal: 'undetermined' })), 'write');
    should(secret === undefined ? undefined : bodyOf(secret)).match({
      error: 'this device may not write: that changes the secret store',
      code: 'grant_undetermined',
    });
  });
});

describe('spentSecretWrite', () => {
  it('should spend a governed caller’s single-use step-up, and an ungoverned one has none to spend', () => {
    let spent = 0;
    const governed = {
      ...governedBy({ allowed: true, refusal: 'granted' }),
      spendFreshStepUp: () => {
        spent += 1;
      },
    };
    spentSecretWrite(contextOf(governed as ReturnType<typeof ownerStanding>));
    should(spent).equal(1);

    const ungoverned = {
      ...ownerStanding(),
      spendFreshStepUp: () => {
        spent += 1;
      },
    };
    spentSecretWrite(contextOf(ungoverned));
    should(spent).equal(1);

    // A governed standing that holds no spend hook is simply left alone.
    const { spendFreshStepUp: _unused, ...bare } = governedBy({ allowed: true, refusal: 'granted' });
    should(() => spentSecretWrite(contextOf(bare as ReturnType<typeof ownerStanding>))).not.throw();
  });
});

describe('freshSubject', () => {
  it('should hand the derived subject string through unchanged', () => {
    should(freshSubject(STEP_UP_ACTS.approvePasteRule, 'subject-bytes')).equal('subject-bytes');
  });
});
