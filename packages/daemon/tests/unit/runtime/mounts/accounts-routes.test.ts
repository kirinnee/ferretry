import { describe, it } from 'bun:test';
import {
  AccountHintListSchema,
  AccountListSchema,
  AccountLookAlikeSchema,
  AccountSummarySchema,
  LoginEntryListSchema,
  LoginHintListSchema,
  PutLoginEntryRequestSchema,
  SignInSummarySchema,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { type SecretSubsystem, secretRoutes } from '../../../../src/lib/runtime/mounts/secrets.ts';
import { jsonBody, request } from '../../api/support.ts';
import { SecretStoreError } from '../../../../src/lib/secrets/index.ts';
import { agentIn, CREDENTIALS, GRANTED, human, MemoryLoginIndex, plantSeed, secretSubsystem } from './support.ts';

/**
 * `/v1/accounts*` and the saved-login routes over the account store (r1-plan §1.5, §5 invariants 1, 19, 21; lead
 * amendments 3 and 4): no answer carries a password or a seed, every write — and the look-alike read — is the
 * owner's and is refused to a ferret before its body is read, the look-alike answer is handles only and leaves no
 * trace, and an older CLI's body that cannot say which sign-in it means is a 409, never a guess.
 */

const PASSWORD = 'hunter2-UNIQUE-pw';
const SEED = 'JBSWY3DPEHPK3PXP';

function dispatchAs(
  headers: Record<string, string>,
  subsystem: SecretSubsystem,
  method: string,
  path: string,
  body?: unknown,
) {
  const [route = path, search = ''] = path.split('?');
  const reads = { limits: [] as (number | undefined)[], consumed: false, discarded: false };
  const response = new ApiDispatcher(new ApiRouter(secretRoutes(subsystem)), CREDENTIALS, GRANTED).dispatch(
    request({
      method,
      path: route,
      query: [...new URLSearchParams(search)],
      headers,
      reads,
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
  );
  return Object.assign(response, { reads });
}

const dispatch = (subsystem: SecretSubsystem, method: string, path: string, body?: unknown) =>
  dispatchAs(human, subsystem, method, path, body);

/** An account with a password and a seed, at a website and an ssh host; a provider; a site that goes via it. */
async function world() {
  const index = new MemoryLoginIndex();
  const subsystem = secretSubsystem({ loginIndex: index });
  const ok = async (method: string, path: string, body?: unknown) => {
    const response = await dispatch(subsystem, method, path, body);
    should(response.status).equal(200);
    return await jsonBody(response);
  };
  const answers: unknown[] = [];
  answers.push(await ok('PUT', '/v1/accounts/GITHUB', { label: 'GitHub', username: 'kirin', password: PASSWORD }));
  answers.push(
    await ok('PUT', '/v1/secrets/logins/GITHUB', PutLoginEntryRequestSchema.parse({ match: ['github.com'] })),
  );
  // A seed is saved only through the passkey-bound commit now; the fixture plants it the way that commit does.
  await plantSeed(subsystem.accounts as NonNullable<SecretSubsystem['accounts']>, 'GITHUB', SEED);
  answers.push(
    await ok('POST', '/v1/accounts/GITHUB/sign-ins', {
      place: { kind: 'terminal', tool: 'ssh', host: 'kirin-box', dest: 'build.example.com' },
    }),
  );
  answers.push(await ok('PUT', '/v1/accounts/GOOGLE', { label: 'Google', username: 'kirin', password: PASSWORD }));
  answers.push(
    await ok('POST', '/v1/accounts/GOOGLE/sign-ins', {
      place: { kind: 'site', domains: ['accounts.google.com'], match: ['google.com'] },
    }),
  );
  answers.push(await ok('PUT', '/v1/accounts/SITE', { label: 'Site' }));
  const linked = (await ok('POST', '/v1/accounts/SITE/sign-ins', {
    place: { kind: 'site', domains: ['site.example'], match: [] },
    method: { kind: 'google', via: 'GOOGLE' },
    recipe: 'Continue with Google as [[GOOGLE]]',
  })) as { id: string };
  answers.push(linked);
  return { index, subsystem, ok, answers, linked };
}

const leaks = (body: unknown): string[] => {
  const text = JSON.stringify(body);
  return [PASSWORD, SEED, SEED.toLowerCase(), [...PASSWORD].reverse().join(''), [...SEED].reverse().join('')].filter(
    value => text.includes(value),
  );
};

describe('no account route answers a value', () => {
  it('should carry neither the password nor the seed (nor its base32) in any answer', async () => {
    const w = await world();
    const reads = [
      await w.ok('GET', '/v1/accounts'),
      await w.ok('GET', '/v1/accounts/hint?site=github.com'),
      await w.ok('GET', '/v1/accounts/hint?site=site.example'),
      await w.ok('GET', '/v1/accounts/look-alike'),
      await w.ok('GET', '/v1/secrets/logins'),
      await w.ok('GET', '/v1/secrets/logins/hint?site=github.com'),
      await w.ok('POST', '/v1/accounts/GOOGLE/rename', { to: 'GOOGLE_KIRIN' }),
      await w.ok('PUT', `/v1/accounts/sign-ins/${w.linked.id}`, { recipe: 'Continue with Google' }),
      await w.ok('POST', '/v1/accounts/GITHUB/apart', { from: 'GOOGLE_KIRIN' }),
    ];
    for (const answer of [...w.answers, ...reads]) should(leaks(answer)).deepEqual([]);
    should(AccountListSchema.safeParse(reads[0]).success).be.true();
    should(AccountHintListSchema.safeParse(reads[1]).success).be.true();
    should(AccountLookAlikeSchema.safeParse(reads[3]).success).be.true();
    // The projection an older app and CLI parse, strictly.
    should(LoginEntryListSchema.safeParse(reads[4]).success).be.true();
    should(LoginHintListSchema.safeParse(reads[5]).success).be.true();
    // The index itself names seals, never values.
    should(leaks(w.index.document)).deepEqual([]);
  });

  it('should have no field that could hold a value in any shape a client reads', () => {
    const keys = (shape: { shape: Record<string, unknown> }) => Object.keys(shape.shape);
    for (const key of [
      ...keys(AccountSummarySchema as never),
      ...keys(SignInSummarySchema),
      ...keys(AccountListSchema),
      ...keys(AccountLookAlikeSchema),
    ])
      should(key).not.match(/password|seed|secret|value|code|seal/iu);
  });
});

describe('every account write is the owner’s', () => {
  it('should refuse a ferret on every write and on look-alike, before the body is read', async () => {
    const w = await world();
    const before = JSON.stringify(w.index.document);
    const routes: [string, string][] = [
      ['PUT', '/v1/accounts/GITHUB'],
      ['POST', '/v1/accounts/GITHUB/rename'],
      ['DELETE', '/v1/accounts/GITHUB'],
      ['POST', '/v1/accounts/GITHUB/sign-ins'],
      ['PUT', `/v1/accounts/sign-ins/${w.linked.id}`],
      ['DELETE', `/v1/accounts/sign-ins/${w.linked.id}`],
      ['POST', `/v1/accounts/sign-ins/${w.linked.id}/recipe/proposals/rp_0000000000000001`],
      ['POST', '/v1/accounts/GITHUB/merge'],
      ['POST', '/v1/accounts/GITHUB/apart'],
      ['GET', '/v1/accounts/look-alike'],
      // The owner's listing too: which fields exist, which keys make codes (secrev-r1-2 L1). A ferret reads the hint.
      ['GET', '/v1/accounts'],
      // The saved-login spellings of the same store.
      ['PUT', '/v1/secrets/logins/GITHUB'],
      ['POST', '/v1/secrets/logins/GITHUB/rename'],
      ['DELETE', '/v1/secrets/logins/GITHUB'],
    ];
    for (const [method, path] of routes) {
      const response = dispatchAs(agentIn('ferret-1'), w.subsystem, method, path, method === 'GET' ? undefined : '{');
      should((await response).status).equal(403);
      should(response.reads.consumed).be.false();
    }
    should(JSON.stringify(w.index.document)).equal(before);
  });
});

describe('these look like one account', () => {
  it('should answer handles only, change nothing, and never reach a hint', async () => {
    const w = await world();
    const index = JSON.stringify(w.index.document);

    const groups = await w.ok('GET', '/v1/accounts/look-alike');

    should(groups).deepEqual({ v: 1, groups: [['GITHUB', 'GOOGLE']] });
    should(JSON.stringify(w.index.document)).equal(index);
    const hint = JSON.stringify(await w.ok('GET', '/v1/accounts/hint?site=github.com'));
    for (const word of ['groups', 'apartFrom', 'lookAlike', 'GOOGLE']) should(hint).not.containEql(word);

    await w.ok('POST', '/v1/accounts/GITHUB/apart', { from: 'GOOGLE' });
    should(await w.ok('GET', '/v1/accounts/look-alike')).deepEqual({ v: 1, groups: [] });
  });

  it('should merge on the owner’s word, and refuse a pair that signs in at one place', async () => {
    const w = await world();
    await w.ok('POST', '/v1/accounts/GOOGLE/sign-ins', { place: { kind: 'site', domains: ['github.com'], match: [] } });
    const clash = await dispatch(w.subsystem, 'POST', '/v1/accounts/GITHUB/merge', { from: 'GOOGLE' });
    should(clash.status).equal(409);
    should(((await jsonBody(clash)) as { code: string }).code).equal('merge_refused');
  });
});

describe('an older client over the account store', () => {
  it("should answer 409 account_has_sign_ins to an old CLI's change to where it signs in, and take its account fields", async () => {
    const w = await world();
    // `fy secret entry edit GITHUB --match github.com` and `--method github` from an older CLI: these bodies, exactly.
    for (const body of [{ match: ['github.com'] }, { method: { kind: 'github' } }, { recipe: 'Open github.com' }]) {
      const refused = await dispatch(
        w.subsystem,
        'PUT',
        '/v1/secrets/logins/GITHUB',
        PutLoginEntryRequestSchema.parse(body),
      );
      should(refused.status).equal(409);
      const answer = (await jsonBody(refused)) as { code: string; error: string };
      should(answer.code).equal('account_has_sign_ins');
      should(answer.error).containEql('2 places');
    }
    const relabelled = (await w.ok('PUT', '/v1/secrets/logins/GITHUB', { label: 'GitHub (kirin)' })) as {
      label: string;
      match: string[];
      domains: string[];
    };
    should(relabelled.label).equal('GitHub (kirin)');
    should(relabelled.match).deepEqual(['github.com', 'ssh@build.example.com']);
    should(relabelled.domains).deepEqual(['github.com']);
  });

  it('should keep the saved-login hint for an older app, built from the accounts', async () => {
    const w = await world();
    const hint = (await w.ok('GET', '/v1/secrets/logins/hint?site=site.example')) as {
      hints: { id: string; role: string }[];
    };
    should(hint.hints.map(each => [each.id, each.role])).deepEqual([
      ['SITE', 'site'],
      ['GOOGLE', 'provider'],
    ]);
  });
});

describe('the account routes, the rest of their answers', () => {
  it('should remove a sign-in and an account, and say 404 for one that is gone', async () => {
    const w = await world();
    should(await w.ok('DELETE', `/v1/accounts/sign-ins/${w.linked.id}`)).deepEqual({ id: w.linked.id, removed: true });
    should((await dispatch(w.subsystem, 'DELETE', `/v1/accounts/sign-ins/${w.linked.id}`)).status).equal(404);
    should(await w.ok('DELETE', '/v1/accounts/SITE')).deepEqual({ id: 'SITE', removed: true });
    should((await dispatch(w.subsystem, 'DELETE', '/v1/accounts/SITE')).status).equal(404);
    should((await dispatch(w.subsystem, 'PUT', '/v1/accounts/lower', { label: 'x' })).status).equal(400);
    should((await dispatch(w.subsystem, 'DELETE', '/v1/accounts/sign-ins/nope')).status).equal(400);
  });

  it('should let the owner answer a proposal on a sign-in, and refuse a proposal id that is not one', async () => {
    const w = await world();
    const recipes = w.subsystem.loginRecipes as NonNullable<SecretSubsystem['loginRecipes']>;
    await recipes.propose(
      'ferret-1',
      { signIn: w.linked.id },
      'Continue with Google, then pick kirin',
      'it asks which account',
    );
    const proposalId = (
      (await w.ok('GET', '/v1/accounts')) as { signIns: { id: string; proposals?: { id: string }[] }[] }
    ).signIns.find(signIn => signIn.id === w.linked.id)?.proposals?.[0]?.id as string;
    const path = `/v1/accounts/sign-ins/${w.linked.id}/recipe/proposals/${proposalId}`;

    const approved = (await w.ok('POST', path, { decision: 'approve' })) as { recipe: string; recipeVersion: number };

    should(approved.recipe).equal('Continue with Google, then pick kirin');
    should(approved.recipeVersion).equal(2);
    should((await dispatch(w.subsystem, 'POST', path, { decision: 'decline' })).status).equal(404);
    should(
      (
        await dispatch(w.subsystem, 'POST', `/v1/accounts/sign-ins/${w.linked.id}/recipe/proposals/nope`, {
          decision: 'approve',
        })
      ).status,
    ).equal(400);
  });

  it('should serve no recipe, and take none, where nothing can check one for values', async () => {
    const w = await world();
    const { loginRecipes: _none, ...bare } = w.subsystem;
    const listed = (await jsonBody(await dispatch(bare, 'GET', '/v1/accounts'))) as { signIns: object[] };
    for (const signIn of listed.signIns) should(signIn).not.have.properties(['recipe', 'recipeVersion', 'proposals']);
    should((await dispatch(bare, 'PUT', `/v1/accounts/sign-ins/${w.linked.id}`, { recipe: 'x' })).status).equal(503);
    const changed = await dispatch(bare, 'PUT', `/v1/accounts/sign-ins/${w.linked.id}`, { autoApplyRecipe: true });
    should(((await jsonBody(changed)) as { autoApplyRecipe: boolean }).autoApplyRecipe).be.true();
    const added = await dispatch(bare, 'POST', '/v1/accounts/SITE/sign-ins', {
      place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' },
    });
    should(added.status).equal(200);
    should(
      secretRoutes(bare).some(route => route.path === '/v1/accounts/sign-ins/:signIn/recipe/proposals/:proposalId'),
    ).be.false();
  });

  it('should say a damaged store is damaged, on the list, the hint and look-alike — never an empty answer', async () => {
    const broken = secretSubsystem({
      loginIndex: new MemoryLoginIndex(new SecretStoreError('unreadable', 'login-entries.json is not JSON')),
    });
    const listed = (await jsonBody(await dispatch(broken, 'GET', '/v1/accounts'))) as {
      health: string;
      diagnosis: string;
    };
    should(listed.health).equal('damaged');
    should(listed.diagnosis).containEql('not JSON');
    should((await dispatch(broken, 'GET', '/v1/accounts/hint?site=github.com')).status).equal(500);
    should((await dispatch(broken, 'GET', '/v1/accounts/look-alike')).status).equal(500);
    should((await dispatch(broken, 'GET', '/v1/accounts/hint')).status).equal(400);
  });

  it('should serve no look-alike route where the daemon holds no look-alike answer', () => {
    const { lookAlike: _none, ...bare } = secretSubsystem();
    should(secretRoutes(bare).some(route => route.path === '/v1/accounts/look-alike')).be.false();
  });
});
