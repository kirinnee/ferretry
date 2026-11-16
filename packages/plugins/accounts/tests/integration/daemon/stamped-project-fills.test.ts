/**
 * A STANDING RULE SCOPED TO A PROJECT, as the Vault reaches it (docs/input-requests.md, "Standing rule fills"): the
 * project a rule covers is the one STAMPED on the ferret at its start, read from Ferrets' own record through
 * `stampedProjectOfFerret`, the very read `buildRules` hands the rule source. A ferret of that project fills; an unfiled
 * ferret, a ferret of another project and a read that fails leave the card to the owner.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { AccountKey } from '../../../contract/routes/index.ts';
import { stampedProjectOfFerret } from '../../../daemon/adapters/pending-reads.ts';
import { SignInGrantLedger } from '../../../daemon/lib/sign-in-grants/ledger.ts';
import { RuleSignInGrants } from '../../../daemon/lib/sign-in-grants/rules.ts';
import { approved, GITHUB, KEY, NOW, world } from '../../unit/daemon/sign-in-rules/support.ts';

const PROJECT = '3f6f2a8e-0000-4000-8000-000000000001';
const OTHER_PROJECT = '3f6f2a8e-0000-4000-8000-000000000002';
const STAMPED = 'mvv6b4qw-49d0158d';
const UNFILED = 'mvv6b4qw-0000000a';
const ELSEWHERE = 'mvv6b4qw-0000000b';
const BROKEN = 'mvv6b4qw-0000000c';
const UNKNOWN = 'mvv6b4qw-0000000d';

const records: Readonly<Record<string, { folder: string; projectId?: string } | undefined>> = {
  [STAMPED]: { folder: '/work/app', projectId: PROJECT },
  [UNFILED]: { folder: '/work/app', projectId: 'unfiled' },
  [ELSEWHERE]: { folder: '/work/app', projectId: OTHER_PROJECT },
  // A ferret from before boards existed: no stamped project, whatever folder it works in.
  [BROKEN]: { folder: '/work/app' },
};
const ferrets = {
  current: () => ({
    get: async (id: string) => {
      if (id === UNKNOWN) throw new Error('down');
      return records[id];
    },
  }),
};

async function offered() {
  const w = await world();
  await approved(w, { signIn: GITHUB, fields: ['username', 'password'], scope: { kind: 'project', project: PROJECT } });
  const source = new RuleSignInGrants({
    rules: w.service,
    ledger: new SignInGrantLedger(),
    keys: async () => KEY as AccountKey,
    terminal: () => true,
    stampedProject: async sessionId => await stampedProjectOfFerret(ferrets as never, sessionId),
    clock: { now: () => w.clock.now },
  });
  const [grant] = source.of(STAMPED);
  if (grant === undefined) throw new Error('no grant');
  return async (sessionId: string): Promise<boolean> =>
    source.holds(grant, {
      sessionId,
      project: await source.projectOf(sessionId),
      roles: ['username', 'password'],
      now: NOW,
    });
}

describe('a standing rule scoped to a project fills by the ferret’s STAMPED project', () => {
  it('should fill for a session of a ferret stamped with that project', async () => {
    should(await (await offered())(STAMPED)).equal(true);
  });

  it('should leave the card to the owner for an unfiled ferret, a ferret of another project, a record with no project and a ferret Ferrets does not know', async () => {
    const fills = await offered();
    should(await fills(UNFILED)).equal(false);
    should(await fills(ELSEWHERE)).equal(false);
    should(await fills(BROKEN)).equal(false);
    should(await fills('mvv6b4qw-ffffffff')).equal(false);
  });

  it('should leave the card to the owner when the read fails or Ferrets is off', async () => {
    const fills = await offered();
    should(await fills(UNKNOWN)).equal(false);
    should(await stampedProjectOfFerret({ current: () => undefined } as never, STAMPED)).be.undefined();
  });
});
