import { describe, it } from 'bun:test';
import should from 'should';
import { ApiError } from '@ferretry/kernel/contract';
import {
  ApplyLedger,
  namedPartial,
  namingWhatLanded,
  type PlannedWrites,
} from '../../../daemon/lib/service/apply-ledger.ts';
import { partlyAppliedOf } from '../../../daemon/lib/service/apply-bracket.ts';
import { FleetCatalogFreshStepUpRequired, FleetCatalogRefusal } from '../../../daemon/lib/service/catalog-service.ts';

/** An import of two keys, one new login, one owner file, one settings file, and the variables of one login. */
const PLAN: PlannedWrites = {
  secrets: [{ name: 'KEY_A' }, { name: 'KEY_B' }],
  newLogins: [{ id: 'claude-you' }],
  owners: { writes: [{ file: 'components/skills/review/SKILL.md' }] },
  configWrites: [{ path: 'learning.yaml' }],
  loginEnvs: [{ login: 'claude-you' }],
};

describe('ApplyLedger', () => {
  it('should list every kind of write that landed, in the order the apply makes them, and the rest as not landed', () => {
    const files: string[] = [];
    const ledger = new ApplyLedger(files, PLAN);

    ledger.secret('KEY_A');
    ledger.login('claude-you');
    files.push('components/skills/review/SKILL.md');

    should(ledger.landed()).eql(['secret-store key KEY_A', 'login claude-you', 'components/skills/review/SKILL.md']);
    should(ledger.notLanded()).eql([
      'secret-store key KEY_B',
      'learning.yaml',
      'the runtimes and fleet files',
      'variables of login claude-you',
    ]);
  });

  it('should count the fleet and each login whose variables were added', () => {
    const files = ['learning.yaml'];
    const ledger = new ApplyLedger(files, PLAN);
    ledger.fleet();
    ledger.loginVariables('claude-you');

    should(ledger.landed()).eql(['learning.yaml', 'the runtimes and fleet files', 'variables of login claude-you']);
    should(ledger.notLanded()).eql([
      'secret-store key KEY_A',
      'secret-store key KEY_B',
      'login claude-you',
      'components/skills/review/SKILL.md',
    ]);
  });

  it('should not call a login that was already there "not landed"', () => {
    const ledger = new ApplyLedger([], PLAN);
    ledger.existingLogin('claude-you');
    should(ledger.notLanded()).not.containEql('login claude-you');
    should(ledger.landed()).not.containEql('login claude-you');
  });
});

describe('namedPartial', () => {
  const landedOne = (): ApplyLedger => {
    const ledger = new ApplyLedger([], PLAN);
    ledger.secret('KEY_A');
    return ledger;
  };

  it('should keep a request that ended as that, and add both lists in words and as facts', () => {
    const named = namedPartial(new ApiError(499, 'the request ended', 'request_aborted'), landedOne()) as ApiError;

    should(named).be.instanceOf(ApiError);
    should(named.status).equal(499);
    should(named.code).equal('request_aborted');
    should(named.message).startWith(
      'the request ended. Part of this change was applied: secret-store key KEY_A. The rest was not: ',
    );
    should(partlyAppliedOf(named)?.landed).eql(['secret-store key KEY_A']);
    should(partlyAppliedOf(named)?.notLanded).containEql('the runtimes and fleet files');
  });

  it('should keep a refusal its code', () => {
    const named = namedPartial(new FleetCatalogRefusal('fleet_change_stale', 'it moved.'), landedOne());

    should(named).be.instanceOf(FleetCatalogRefusal);
    should((named as FleetCatalogRefusal).code).equal('fleet_change_stale');
    should((named as Error).message).startWith('it moved. Part of this change was applied: ');
  });

  it('should turn an error nobody can read (a disk error) into a refusal that says what landed, not a bare 500', () => {
    const named = namedPartial(new Error('no space left on device'), landedOne());

    should(named).be.instanceOf(FleetCatalogRefusal);
    should((named as FleetCatalogRefusal).code).equal('fleet_change_failed');
    should((named as Error).message).containEql('no space left on device');
    should((named as FleetCatalogRefusal).extra?.landed).eql(['secret-store key KEY_A']);
  });

  it('should return the error as it was when nothing had landed, and for a passkey step-up', () => {
    const plain = new Error('boom');
    should(namedPartial(plain, new ApplyLedger([], PLAN))).equal(plain);
    const stepUp = new FleetCatalogFreshStepUpRequired();
    should(namedPartial(stepUp, landedOne())).equal(stepUp);
  });

  it('should carry names only: no word of a list is a value', async () => {
    const failure = await namingWhatLanded(PLAN, async (_landed, ledger) => {
      ledger.secret('KEY_A');
      throw new Error('boom');
    }).catch((error: unknown) => error);

    const lists = JSON.stringify((failure as FleetCatalogRefusal).extra);
    should(lists).not.containEql('sk-');
    should(lists).containEql('KEY_A');
  });
});

describe('partlyAppliedOf', () => {
  it('should read the lists of either error class, and nothing from any other error', () => {
    const extra = { landed: ['a'], notLanded: ['b'] };
    should(partlyAppliedOf(new FleetCatalogRefusal('fleet_change_failed', 'x', extra))).eql(extra);
    should(partlyAppliedOf(new ApiError(499, 'x', 'request_aborted', undefined, extra))).eql(extra);
    should(partlyAppliedOf(new Error('x'))).be.undefined();
    should(partlyAppliedOf(new FleetCatalogRefusal('fleet_change_failed', 'x', { landed: [] }))).be.undefined();
  });
});
