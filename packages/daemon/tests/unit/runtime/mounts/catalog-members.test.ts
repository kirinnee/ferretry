import { describe, it } from 'bun:test';
import { STEP_UP_ACTS, STEP_UP_REQUIRED_CODE } from '@ferretry/protocol';
import should from 'should';
import { NodeShareCodeHasher } from '../../../../src/adapters/catalog-members/sha256-hasher.ts';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import type { CallerGovernance } from '../../../../src/lib/api/capability.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  CATALOG_MEMBER_REFUSALS,
  CatalogMemberRefusal,
  type CatalogMemberRefusalCode,
  CatalogMemberService,
  EMPTY_MEMBERS_DOCUMENT,
  EMPTY_SHARES_DOCUMENT,
  type MembersDocument,
  type SharesDocument,
} from '../../../../src/lib/catalog-members/index.ts';
import {
  type CatalogMemberSubsystem,
  catalogMemberRoutes,
} from '../../../../src/lib/runtime/mounts/catalog-members.ts';
import { bodyReads, jsonBody, request } from '../../api/support.ts';
import { crypto } from '../../shared-catalogs/support.ts';

/**
 * `/v1/catalog-shares` and `/v1/catalog-members`: the eight routes, driven as the dispatcher would. What is
 * asserted is the route's own contract — who may reach it, what minting demands of a governed device, how each
 * refusal is worded in HTTP, that a bad id never reaches the service, and that the code leaves in the mint's
 * answer and nowhere else. The sharing itself is the service's, proven in its own unit tests.
 */

const CAT = `cat_${'c'.repeat(22)}`;
const MEMBER = `mbr_${'m'.repeat(22)}`;
const KEY = `mk_${'k'.repeat(22)}`;
const SHARE = `shr_${'s'.repeat(22)}`;
const CODE = `fy_share_${'Q'.repeat(22)}`;
const LINK = `https://app.example/join#v1;url=x;fp=y;share=${CODE}`;
const NOW = '2026-01-01T00:00:00.000Z';

interface Caller {
  readonly actor: string;
  readonly credential: AuthenticatedCredential;
  readonly governed: boolean;
  /** How many passkey proofs for the act this device holds (default none). */
  readonly proofs?: number;
}

const HOST: Caller = {
  actor: 'admin-cli',
  credential: { kind: 'authenticated', tokenClass: 'admin' },
  governed: false,
};
const DEVICE: Caller = {
  actor: 'device:d1',
  credential: { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' },
  governed: true,
};
const FRESH_DEVICE: Caller = { ...DEVICE, proofs: 1 };
const FERRET: Caller = {
  actor: 'peer:s1',
  credential: { kind: 'authenticated', tokenClass: 'admin' },
  governed: false,
};
/** A ferret on its OWN session credential: the handler refuses it by its class, with no header involved. */
const FERRET_OWN: Caller = {
  actor: 'peer:s1',
  credential: { kind: 'authenticated', tokenClass: 'session', sessionId: 's1' },
  governed: false,
};

const SHARE_VIEW = {
  shareId: SHARE,
  memberId: MEMBER,
  memberLabel: 'Alice',
  catalogIds: [CAT],
  uses: { kind: 'single' },
  expiresAt: NOW,
};
const MINTED = { share: SHARE_VIEW, code: CODE, link: LINK };
const MEMBER_VIEW = { memberId: MEMBER, label: 'Alice', catalogIds: [CAT], createdAt: NOW, keys: [] };

type Members = CatalogMemberSubsystem['members'];

interface Call {
  readonly act: string;
  readonly args: readonly unknown[];
}

class FakeMembers implements Members {
  readonly calls: Call[] = [];
  failure: unknown;

  async mint(req: unknown) {
    this.#record('mint', req);
    return MINTED as never;
  }
  async listShares() {
    this.#record('listShares');
    return { shares: [SHARE_VIEW] } as never;
  }
  async endShare(shareId: string) {
    this.#record('endShare', shareId);
    return { ...SHARE_VIEW, state: 'ended' } as never;
  }
  async listMembers(name?: string) {
    this.#record('listMembers', ...(name === undefined ? [] : [name]));
    return { members: [MEMBER_VIEW] } as never;
  }
  async renameMember(memberId: string, label: string) {
    this.#record('renameMember', memberId, label);
    return { ...MEMBER_VIEW, label } as never;
  }
  async revokeMember(memberId: string) {
    this.#record('revokeMember', memberId);
    return { memberId, keysRemoved: 2, sharesEnded: 1 } as never;
  }
  async removeKey(memberId: string, keyId: string) {
    this.#record('removeKey', memberId, keyId);
    return { memberId, keyId } as never;
  }
  async removeCatalog(memberId: string, catalogId: string) {
    this.#record('removeCatalog', memberId, catalogId);
    return { memberId, catalogId } as never;
  }
  #record(act: string, ...args: unknown[]): void {
    this.calls.push({ act, args });
    if (this.failure !== undefined) throw this.failure;
  }
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly code?: string;
  readonly message?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
  /** How many proofs the route actually took. */
  readonly claimed: number;
  /** Every act the route asked to claim a proof for. */
  readonly claimedActs: readonly string[];
}

async function drive(
  members: Members,
  method: string,
  path: string,
  body: unknown,
  caller: Caller = HOST,
  proofs: { left: number } = { left: caller.proofs ?? 0 },
  query: readonly (readonly [string, string])[] = [],
): Promise<Answer> {
  const found = new ApiRouter(catalogMemberRoutes({ members })).lookup(method, path);
  if (found.kind !== 'matched') throw new Error(`no route ${method} ${path}`);
  let claimed = 0;
  const claimedActs: string[] = [];
  const context: RouteContext = {
    request: request({
      method,
      path,
      query,
      headers: { 'content-type': 'application/json' },
      reads: bodyReads(),
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
    params: found.params,
    actor: caller.actor,
    credential: caller.credential,
    governance: {
      governed: caller.governed,
      decide: () => ({ allowed: true, refusal: 'granted' }),
    } as CallerGovernance,
    presentation: {
      loopback: !caller.governed,
      adminToken: caller.credential.tokenClass === 'admin',
      actor: caller.actor,
      stepUp: false,
      freshStepUp: false,
    },
    claimFreshStepUp: act => {
      claimedActs.push(String(act));
      if (act !== 'share-catalog' || proofs.left <= 0) return false;
      proofs.left -= 1;
      claimed += 1;
      return true;
    },
    spendFreshStepUp: () => undefined,
  };
  try {
    const response = await found.route.handle(context);
    return { status: response.status, body: jsonBody(response) as Record<string, unknown>, claimed, claimedActs };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return {
      status: error.status,
      body: { error: error.message },
      code: error.code,
      message: error.message,
      extra: error.extra,
      claimed,
      claimedActs,
    };
  }
}

const MINT = {
  catalogIds: [CAT],
  member: { kind: 'new', label: 'Alice' },
  expiresIn: '1h',
  uses: { kind: 'single' },
};

describe('the route table', () => {
  const routes = catalogMemberRoutes({ members: new FakeMembers() });
  const table = [
    ['POST', '/v1/catalog-shares'],
    ['GET', '/v1/catalog-shares'],
    ['DELETE', '/v1/catalog-shares/:shareId'],
    ['GET', '/v1/catalog-members'],
    ['PATCH', '/v1/catalog-members/:memberId'],
    ['DELETE', '/v1/catalog-members/:memberId'],
    ['DELETE', '/v1/catalog-members/:memberId/keys/:keyId'],
    ['DELETE', '/v1/catalog-members/:memberId/catalogs/:catalogId'],
  ] as const;

  it('has exactly the eight routes', () => {
    should(routes.map(route => `${route.method} ${route.path}`)).deepEqual(table.map(([m, p]) => `${m} ${p}`));
  });

  for (const [method, path] of table) {
    it(`${method} ${path} is the operator's, uncached, behind sharing.use`, () => {
      const found = routes.find(route => route.method === method && route.path === path);

      should(found?.minimum).equal('operator');
      should(found?.noStore).equal(true);
      should(found?.capability).deepEqual({ capability: 'sharing', axis: 'use' });
    });
  }
});

describe('minting a share', () => {
  it('hands the service the parsed request and answers 201 with the code and link', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'POST', '/v1/catalog-shares', MINT);

    should(answer.status).equal(201);
    should(answer.body).deepEqual(MINTED);
    should(members.calls).deepEqual([{ act: 'mint', args: [MINT] }]);
  });

  it('asks nothing of the machine itself, which is ungoverned', async () => {
    const answer = await drive(new FakeMembers(), 'POST', '/v1/catalog-shares', MINT, { ...HOST, proofs: 1 });

    should(answer.status).equal(201);
    should(answer.claimedActs).deepEqual([]);
  });

  it('asks a governed device for the passkey for this act alone, and the service is not reached', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'POST', '/v1/catalog-shares', MINT, DEVICE);

    should(answer.status).equal(403);
    should(answer.body.code).equal(STEP_UP_REQUIRED_CODE);
    should(answer.body.demand).deepEqual({ capability: 'sharing', axis: 'use', act: STEP_UP_ACTS.shareCatalog });
    should(answer.body.error).equal('sharing a catalog needs a passkey confirmation for it, from this device');
    should(answer.claimedActs).deepEqual([STEP_UP_ACTS.shareCatalog]);
    should(members.calls).deepEqual([]);
  });

  it('mints for a device that proved it, claiming the proof once', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'POST', '/v1/catalog-shares', MINT, FRESH_DEVICE);

    should(answer.status).equal(201);
    should(answer.claimed).equal(1);
    should(members.calls.map(call => call.act)).deepEqual(['mint']);
  });

  it('lets one proof buy one share even when two mints race for it', async () => {
    const members = new FakeMembers();
    const proofs = { left: 1 };

    const [first, second] = await Promise.all([
      drive(members, 'POST', '/v1/catalog-shares', MINT, DEVICE, proofs),
      drive(members, 'POST', '/v1/catalog-shares', MINT, DEVICE, proofs),
    ]);

    should([first.status, second.status].sort()).deepEqual([201, 403]);
    should(first.claimed + second.claimed).equal(1);
    should(members.calls).have.length(1);
  });

  it('refuses a ferret before it reads the body or touches a proof, naming the owner', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'POST', '/v1/catalog-shares', MINT, { ...FERRET, proofs: 1 });

    should(answer.status).equal(403);
    should(answer.code).equal('forbidden');
    should(answer.message).containEql('a ferret cannot share a catalog; the owner does');
    should(answer.claimedActs).deepEqual([]);
    should(members.calls).deepEqual([]);
  });

  it('refuses a ferret on its own session credential the same way, keyed on its class', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'POST', '/v1/catalog-shares', MINT, { ...FERRET_OWN, proofs: 1 });

    should([answer.status, answer.code]).deepEqual([403, 'forbidden']);
    should(answer.claimedActs).deepEqual([]);
    should(members.calls).deepEqual([]);
  });

  it('refuses a body that is not a mint request, and spends no proof on it', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'POST', '/v1/catalog-shares', { catalogIds: [] }, FRESH_DEVICE);

    should(answer.status).equal(400);
    should(answer.claimedActs).deepEqual([]);
    should(members.calls).deepEqual([]);
  });

  it('refuses a code for many people that names someone already in, until join-by-proof, and spends no proof', async () => {
    const members = new FakeMembers();
    const many = { ...MINT, member: { kind: 'existing', memberId: MEMBER }, uses: { kind: 'multi', cap: 5 } };

    const answer = await drive(members, 'POST', '/v1/catalog-shares', many, FRESH_DEVICE);

    should(answer.status).equal(400);
    should(answer.claimedActs).deepEqual([]);
    should(members.calls).deepEqual([]);
  });

  it('hands a code for many people that names a person by ID to the service, which says whether they are in', async () => {
    const members = new FakeMembers();
    const many = { ...MINT, member: { name: 'Alice' }, uses: { kind: 'multi', cap: 5 } };

    const answer = await drive(members, 'POST', '/v1/catalog-shares', many);

    should(answer.status).equal(201);
    should(members.calls.map(call => call.act)).deepEqual(['mint']);
  });

  it('asks again for the proof once it is spent: a refused mint does not refund it', async () => {
    const members = new FakeMembers();
    members.failure = new CatalogMemberRefusal('share_link_unavailable', 'no address');
    const proofs = { left: 1 };

    const refused = await drive(members, 'POST', '/v1/catalog-shares', MINT, DEVICE, proofs);
    const again = await drive(members, 'POST', '/v1/catalog-shares', MINT, DEVICE, proofs);

    should(refused.status).equal(503);
    should(again.status).equal(403);
    should(again.body.code).equal(STEP_UP_REQUIRED_CODE);
  });
});

describe('how a refusal is worded in HTTP', () => {
  const expected: Readonly<Record<CatalogMemberRefusalCode, number>> = {
    share_refused: 409,
    share_other_member: 409,
    share_new_member: 409,
    member_exists: 409,
    members_full: 409,
    member_unknown: 404,
    member_key_unknown: 404,
    catalog_unknown: 404,
    share_unknown: 404,
    shares_full: 409,
    catalogs_full: 409,
    share_link_unavailable: 503,
    store_damaged: 500,
  };

  it('has an answer for every refusal the service can raise', () => {
    should(Object.keys(expected).sort()).deepEqual([...CATALOG_MEMBER_REFUSALS].sort());
  });

  for (const code of CATALOG_MEMBER_REFUSALS) {
    it(`answers ${code} as ${String(expected[code])}, with the service's own sentence and the code`, async () => {
      const members = new FakeMembers();
      members.failure = new CatalogMemberRefusal(code, 'the sentence');

      const answer = await drive(members, 'POST', '/v1/catalog-shares', MINT);

      should(answer.status).equal(expected[code]);
      should(answer.code).equal(code);
      should(answer.message).equal('the sentence');
    });
  }

  it('lets a failure that is not a refusal through to the dispatcher, which answers 500', async () => {
    const members = new FakeMembers();
    members.failure = new Error('the disk is gone');

    const thrown = await drive(members, 'GET', '/v1/catalog-shares', undefined).then(
      () => undefined,
      (error: unknown) => error,
    );

    should((thrown as Error).message).equal('the disk is gone');
  });
});

describe('listing, which a ferret may do', () => {
  const lists = [
    ['/v1/catalog-shares', 'listShares', { shares: [SHARE_VIEW] }],
    ['/v1/catalog-members', 'listMembers', { members: [MEMBER_VIEW] }],
  ] as const;

  for (const [path, act, expectedBody] of lists) {
    for (const [name, caller] of [
      ['the machine', HOST],
      ['a ferret', FERRET],
      ['a ferret on its own credential', FERRET_OWN],
      ['a governed device', DEVICE],
    ] as const) {
      it(`lets ${name} GET ${path}, with no passkey`, async () => {
        const members = new FakeMembers();

        const answer = await drive(members, 'GET', path, undefined, caller);

        should(answer.status).equal(200);
        should(answer.body).deepEqual(expectedBody);
        should(members.calls.map(call => call.act)).deepEqual([act]);
        should(answer.claimedActs).deepEqual([]);
      });
    }
  }

  it('shows neither a code nor a link anywhere in a list', async () => {
    const shares = await drive(new FakeMembers(), 'GET', '/v1/catalog-shares', undefined);
    const people = await drive(new FakeMembers(), 'GET', '/v1/catalog-members', undefined);

    should(JSON.stringify([shares.body, people.body])).not.match(/fy_share_|share=|\/join/u);
  });
});

describe('ending a share', () => {
  it('hands the service the id from the path', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'DELETE', `/v1/catalog-shares/${SHARE}`, undefined);

    should(answer.status).equal(200);
    should(members.calls).deepEqual([{ act: 'endShare', args: [SHARE] }]);
  });

  it('asks a governed device for no passkey: it only takes access away', async () => {
    const answer = await drive(new FakeMembers(), 'DELETE', `/v1/catalog-shares/${SHARE}`, undefined, DEVICE);

    should(answer.status).equal(200);
    should(answer.claimedActs).deepEqual([]);
  });

  it('refuses a ferret', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'DELETE', `/v1/catalog-shares/${SHARE}`, undefined, FERRET);

    should(answer.status).equal(403);
    should(answer.message).containEql('a ferret cannot end a share');
    should(members.calls).deepEqual([]);
  });

  for (const bad of ['nope', `shr_${'s'.repeat(21)}`, CAT, '%zz', '%2e%2e']) {
    it(`answers 404 share_unknown for ${JSON.stringify(bad)} without reaching the service`, async () => {
      const members = new FakeMembers();

      const answer = await drive(members, 'DELETE', `/v1/catalog-shares/${bad}`, undefined);

      should(answer.status).equal(404);
      should(answer.code).equal('share_unknown');
      should(answer.message).equal('there is no such share');
      should(members.calls).deepEqual([]);
    });
  }

  it('answers an unknown share with the service’s 404', async () => {
    const members = new FakeMembers();
    members.failure = new CatalogMemberRefusal('share_unknown', 'There is no such share.');

    const answer = await drive(members, 'DELETE', `/v1/catalog-shares/${SHARE}`, undefined);

    should(answer.status).equal(404);
    should(answer.code).equal('share_unknown');
  });
});

describe('renaming a person', () => {
  it('hands the service the id and the new label', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'PATCH', `/v1/catalog-members/${MEMBER}`, { label: 'Bob' });

    should(answer.status).equal(200);
    should(answer.body.label).equal('Bob');
    should(members.calls).deepEqual([{ act: 'renameMember', args: [MEMBER, 'Bob'] }]);
  });

  it('refuses a ferret', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'PATCH', `/v1/catalog-members/${MEMBER}`, { label: 'Bob' }, FERRET);

    should(answer.status).equal(403);
    should(answer.message).containEql('a ferret cannot rename a person');
    should(members.calls).deepEqual([]);
  });

  it('answers 404 member_unknown for a bad id, before it reads the body', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'PATCH', '/v1/catalog-members/nope', 'not json at all');

    should(answer.status).equal(404);
    should(answer.code).equal('member_unknown');
    should(answer.message).equal('there is no such member');
    should(members.calls).deepEqual([]);
  });

  for (const bad of [{}, { label: '' }, { label: 'Bob', extra: 1 }, { label: 3 }]) {
    it(`answers 400 for the body ${JSON.stringify(bad)}`, async () => {
      const members = new FakeMembers();

      const answer = await drive(members, 'PATCH', `/v1/catalog-members/${MEMBER}`, bad);

      should(answer.status).equal(400);
      should(members.calls).deepEqual([]);
    });
  }
});

describe('removing a person, a browser, or a catalog', () => {
  it('revokes a person by the id in the path', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'DELETE', `/v1/catalog-members/${MEMBER}`, undefined);

    should(answer.status).equal(200);
    should(answer.body).deepEqual({ memberId: MEMBER, keysRemoved: 2, sharesEnded: 1 });
    should(members.calls).deepEqual([{ act: 'revokeMember', args: [MEMBER] }]);
  });

  it('removes one browser of a person', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'DELETE', `/v1/catalog-members/${MEMBER}/keys/${KEY}`, undefined);

    should(answer.status).equal(200);
    should(answer.body).deepEqual({ memberId: MEMBER, keyId: KEY });
    should(members.calls).deepEqual([{ act: 'removeKey', args: [MEMBER, KEY] }]);
  });

  it('takes one catalog away from a person', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'DELETE', `/v1/catalog-members/${MEMBER}/catalogs/${CAT}`, undefined);

    should(answer.status).equal(200);
    should(answer.body).deepEqual({ memberId: MEMBER, catalogId: CAT });
    should(members.calls).deepEqual([{ act: 'removeCatalog', args: [MEMBER, CAT] }]);
  });

  const owned = [
    ['DELETE', `/v1/catalog-members/${MEMBER}`, 'a ferret cannot remove a person'],
    ['DELETE', `/v1/catalog-members/${MEMBER}/keys/${KEY}`, "a ferret cannot remove a person's browser"],
    ['DELETE', `/v1/catalog-members/${MEMBER}/catalogs/${CAT}`, 'a ferret cannot take a catalog away from a person'],
  ] as const;

  for (const [method, path, sentence] of owned) {
    it(`refuses a ferret on ${method} ${path}, on the admin token or its own credential`, async () => {
      const members = new FakeMembers();

      const answers = [
        await drive(members, method, path, undefined, FERRET),
        await drive(members, method, path, undefined, FERRET_OWN),
      ];

      for (const answer of answers) {
        should(answer.status).equal(403);
        should(answer.code).equal('forbidden');
        should(answer.message).containEql(sentence);
      }
      should(members.calls).deepEqual([]);
    });

    it(`asks a governed device for no passkey on ${method} ${path}: it only takes access away`, async () => {
      const answer = await drive(new FakeMembers(), method, path, undefined, DEVICE);

      should(answer.status).equal(200);
      should(answer.claimedActs).deepEqual([]);
    });
  }

  const wrong = [
    ['/v1/catalog-members/nope', 'member_unknown', 'member'],
    [`/v1/catalog-members/nope/keys/${KEY}`, 'member_unknown', 'member'],
    [`/v1/catalog-members/nope/catalogs/${CAT}`, 'member_unknown', 'member'],
    [`/v1/catalog-members/${MEMBER}/keys/nope`, 'member_key_unknown', 'browser'],
    [`/v1/catalog-members/${MEMBER}/keys/${MEMBER}`, 'member_key_unknown', 'browser'],
    [`/v1/catalog-members/${MEMBER}/catalogs/nope`, 'catalog_unknown', 'catalog'],
    [`/v1/catalog-members/${MEMBER}/catalogs/${KEY}`, 'catalog_unknown', 'catalog'],
  ] as const;

  for (const [path, code, what] of wrong) {
    it(`answers 404 ${code} for DELETE ${path} without reaching the service`, async () => {
      const members = new FakeMembers();

      const answer = await drive(members, 'DELETE', path, undefined);

      should(answer.status).equal(404);
      should(answer.code).equal(code);
      should(answer.message).equal(`there is no such ${what}`);
      should(members.calls).deepEqual([]);
    });
  }

  it('answers the service’s refusal for a person who is not in the list', async () => {
    const members = new FakeMembers();
    members.failure = new CatalogMemberRefusal('member_unknown', 'There is no such member.');

    const answer = await drive(members, 'DELETE', `/v1/catalog-members/${MEMBER}`, undefined);

    should(answer.status).equal(404);
    should(answer.code).equal('member_unknown');
  });
});

describe('a person’s user ID on the wire', () => {
  it('lists with no name by default', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'GET', '/v1/catalog-members', undefined);

    should(answer.status).equal(200);
    should(members.calls).deepEqual([{ act: 'listMembers', args: [] }]);
  });

  it('hands the name to the service so the share sheet can say who is already in', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'GET', '/v1/catalog-members', undefined, HOST, undefined, [['name', 'Alice']]);

    should(answer.status).equal(200);
    should(members.calls).deepEqual([{ act: 'listMembers', args: ['Alice'] }]);
  });

  it('refuses a name with a hidden character, in the words a person reads', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'GET', '/v1/catalog-members', undefined, HOST, undefined, [
      ['name', 'Al\u200Bice'],
    ]);

    should(answer.status).equal(400);
    should(answer.code).equal('invalid_name');
    should(answer.message).equal("A user ID can't contain hidden characters. Type it again.");
    should(members.calls).deepEqual([]);
  });

  it('refuses any other parameter instead of ignoring it', async () => {
    const members = new FakeMembers();

    const answer = await drive(members, 'GET', '/v1/catalog-members', undefined, HOST, undefined, [['nam', 'Alice']]);

    should(answer.status).equal(400);
    should(answer.code).equal('unknown_parameter');
    should(members.calls).deepEqual([]);
  });

  it('answers a taken name 409 member_exists with the person who has it', async () => {
    const members = new FakeMembers();
    members.failure = new CatalogMemberRefusal(
      'member_exists',
      'Someone here already has the user ID Alice. Pick another.',
      MEMBER,
    );

    const answer = await drive(members, 'PATCH', `/v1/catalog-members/${MEMBER}`, { label: 'Alice' });

    should(answer.status).equal(409);
    should(answer.code).equal('member_exists');
    should(answer.message).equal('Someone here already has the user ID Alice. Pick another.');
    should(answer.extra).deepEqual({ memberId: MEMBER });
  });
});

/**
 * The same routes in front of the real service, so "the code is in the mint's answer and nowhere else" is
 * proved against what the service really returns, not against what a stub was told to say.
 */
describe('the code leaves in one answer only', () => {
  class MemoryMembers {
    document: MembersDocument = EMPTY_MEMBERS_DOCUMENT;
    takeUpgrade() {
      return undefined;
    }
    async read() {
      return this.document;
    }
    async write(document: MembersDocument) {
      this.document = document;
    }
  }
  class MemoryShares {
    document: SharesDocument = EMPTY_SHARES_DOCUMENT;
    async read() {
      return this.document;
    }
    async write(document: SharesDocument) {
      this.document = document;
    }
  }

  function real() {
    const store = { members: new MemoryMembers(), shares: new MemoryShares() };
    const audited: unknown[] = [];
    const service = new CatalogMemberService({
      members: store.members,
      shares: store.shares,
      hasher: new NodeShareCodeHasher(),
      crypto,
      catalogs: { knownIds: async () => new Set([CAT]) },
      links: {
        target: () => ({
          kind: 'ready',
          appOrigin: 'https://app.example',
          daemonUrl: 'https://studio.example:8443',
          daemonId: `fy_daemon_${'D'.repeat(43)}`,
        }),
      },
      sessions: { closeMember: async () => undefined, closeKey: async () => undefined },
      audit: {
        record: async entry => {
          audited.push(entry);
        },
      },
      now: () => Date.parse(NOW),
    });
    return { store, service, audited };
  }

  it('puts the code and link in the mint answer, and the code in no other body, record or file', async () => {
    const { store, service, audited } = real();

    const minted = await drive(service, 'POST', '/v1/catalog-shares', MINT);
    const code = minted.body.code as string;
    const share = minted.body.share as { shareId: string; memberId: string };
    const others = [
      await drive(service, 'GET', '/v1/catalog-shares', undefined),
      await drive(service, 'GET', '/v1/catalog-members', undefined),
      await drive(service, 'DELETE', `/v1/catalog-shares/${share.shareId}`, undefined),
      await drive(service, 'DELETE', `/v1/catalog-shares/${share.shareId}`, undefined),
      await drive(service, 'GET', '/v1/catalog-shares', undefined),
    ];

    should(minted.status).equal(201);
    should(code).match(/^fy_share_[A-Za-z0-9_-]{22}$/u);
    should(minted.body.link).containEql(`share=${code}`);
    should(others.map(other => other.status)).deepEqual([200, 200, 200, 200, 200]);
    for (const other of others) should(JSON.stringify(other.body)).not.containEql(code);
    should(JSON.stringify(store.shares.document)).not.containEql(code);
    should(JSON.stringify(store.members.document)).not.containEql(code);
    should(JSON.stringify(audited)).not.containEql(code);
  });

  it('refuses to mint, and spends nothing, when the machine has no address for a link', async () => {
    const { store } = real();
    const bare = new CatalogMemberService({
      members: store.members,
      shares: store.shares,
      hasher: new NodeShareCodeHasher(),
      crypto,
      catalogs: { knownIds: async () => new Set([CAT]) },
      links: { target: () => ({ kind: 'unavailable', reason: 'this machine is only reachable from itself' }) },
      sessions: { closeMember: async () => undefined, closeKey: async () => undefined },
      audit: { record: async () => undefined },
      now: () => Date.parse(NOW),
    });

    const answer = await drive(bare, 'POST', '/v1/catalog-shares', MINT);

    should(answer.status).equal(503);
    should(answer.code).equal('share_link_unavailable');
    should(store.shares.document).deepEqual(EMPTY_SHARES_DOCUMENT);
  });
});
