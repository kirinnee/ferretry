/**
 * APPROVING A RECIPE FROM A PAIRED DEVICE wants a passkey proved for it (`approve-recipe`, owner decision !A320), on
 * both spellings of the route; the machine itself is ungoverned, and a decline never asks. "Approve my version" puts
 * the owner's own text in the ferret's place, checked for values like any recipe.
 */
import { describe, it } from 'bun:test';
import { STEP_UP_ACTS, STEP_UP_REQUIRED_CODE } from '@ferretry/protocol';
import should from 'should';
import type { CallerGovernance } from '../../../../src/lib/api/capability.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { type SecretSubsystem, secretRoutes } from '../../../../src/lib/runtime/mounts/secrets.ts';
import { LoginRecipeService } from '../../../../src/lib/secrets/index.ts';
import { bodyReads, jsonBody, request } from '../../api/support.ts';
import { MemoryLoginIndex, secretSubsystem } from './support.ts';

interface Caller {
  readonly governed: boolean;
  /** The device holds a fresh proof for this act (claimed at most once). */
  readonly proved?: string;
}
const MACHINE: Caller = { governed: false };
const DEVICE: Caller = { governed: true };
const DEVICE_PROVED: Caller = { governed: true, proved: STEP_UP_ACTS.approveRecipe };
const DEVICE_OTHER_ACT: Caller = { governed: true, proved: STEP_UP_ACTS.shareLink };

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly claimed: readonly string[];
}

async function call(subsystem: SecretSubsystem, caller: Caller, path: string, body: unknown): Promise<Answer> {
  const found = new ApiRouter(secretRoutes(subsystem)).lookup('POST', path);
  if (found.kind !== 'matched') throw new Error(`no route POST ${path}`);
  const claimed: string[] = [];
  let proof = caller.proved;
  const context: RouteContext = {
    request: request({
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
      reads: bodyReads(),
      body: JSON.stringify(body),
    }),
    params: found.params,
    actor: caller.governed ? 'device:d1' : 'admin-cli',
    credential: caller.governed
      ? { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' }
      : { kind: 'authenticated', tokenClass: 'admin' },
    governance: { governed: caller.governed, decide: () => ({ allowed: true, refusal: 'granted' }) } as CallerGovernance,
    presentation: { loopback: !caller.governed, adminToken: !caller.governed, actor: 'x', stepUp: false, freshStepUp: false },
    claimFreshStepUp: act => {
      claimed.push(String(act));
      const held = proof === act;
      proof = undefined;
      return held;
    },
    spendFreshStepUp: () => undefined,
  };
  try {
    const response = await found.route.handle(context);
    return { status: response.status, body: (await jsonBody(response)) as Record<string, unknown>, claimed };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { error: error.message, code: error.code }, claimed };
  }
}

/** A made-up saved value, which the fixture's redactor masks wherever it appears. */
const PASSWORD = 'correct-horse-battery-staple';

/** One account with one sign-in and a ferret's waiting proposal for it. */
async function world() {
  const base = secretSubsystem({ loginIndex: new MemoryLoginIndex() });
  const logins = base.logins as NonNullable<SecretSubsystem['logins']>;
  const accounts = logins.accounts;
  const recipes = new LoginRecipeService({
    logins,
    accounts,
    values: { redact: async text => text.replaceAll(PASSWORD, '[redacted]') },
    agenda: { raise: async () => ({ ok: true, id: 'A1' }), close: async () => undefined },
    audit: { record: async () => undefined },
    clock: { now: () => '2026-11-03T09:00:00.000Z' },
    newId: () => 'rp_0000000000000001',
  });
  const subsystem: SecretSubsystem = { ...base, loginRecipes: recipes };
  await accounts.putAccount('SITE', { label: 'Site', password: PASSWORD });
  const signIn = await accounts.addSignIn('SITE', {
    place: { kind: 'site', domains: ['site.example'], match: [] },
    recipe: 'Open site.example and sign in',
  });
  const proposed = await recipes.propose('ferret-1', { signIn: signIn.id }, 'Open site.example, then the 2FA page', 'it asks for a code now');
  const proposalPath = `/v1/accounts/sign-ins/${signIn.id}/recipe/proposals/${proposed.id}`;
  const recipeOf = async (): Promise<string | undefined> =>
    (await accounts.list()).signIns.find(each => each.id === signIn.id)?.recipe;
  return { subsystem, signIn, proposed, proposalPath, recipeOf };
}

describe('approving a recipe from a paired device (#F640)', () => {
  it('asks a governed device for a passkey for this act, and approves nothing without one', async () => {
    const w = await world();
    const refused = await call(w.subsystem, DEVICE, w.proposalPath, { decision: 'approve' });

    should(refused.status).equal(403);
    should(refused.body.code).equal(STEP_UP_REQUIRED_CODE);
    should((refused.body.demand as { act: string }).act).equal('approve-recipe');
    should(refused.claimed).eql(['approve-recipe']);
    should(await w.recipeOf()).equal('Open site.example and sign in');
  });

  it('takes a passkey proved for another act as no passkey at all', async () => {
    const w = await world();
    should((await call(w.subsystem, DEVICE_OTHER_ACT, w.proposalPath, { decision: 'approve' })).status).equal(403);
    should(await w.recipeOf()).equal('Open site.example and sign in');
  });

  it('approves with a passkey proved for it, once', async () => {
    const w = await world();
    const approved = await call(w.subsystem, DEVICE_PROVED, w.proposalPath, { decision: 'approve' });

    should(approved.status).equal(200);
    should(await w.recipeOf()).equal('Open site.example, then the 2FA page');
  });

  it('never asks the machine itself, nor a device that declines', async () => {
    const w = await world();
    const declined = await call(w.subsystem, DEVICE, w.proposalPath, { decision: 'decline' });
    should(declined.status).equal(200);
    should(declined.claimed).eql([]);

    const again = await world();
    const machine = await call(again.subsystem, MACHINE, again.proposalPath, { decision: 'approve' });
    should(machine.status).equal(200);
    should(machine.claimed).eql([]);
  });

  it('asks on the older saved-login spelling of the route too', async () => {
    const w = await world();
    const older = `/v1/secrets/logins/SITE/recipe/proposals/${w.proposed.id}`;
    should((await call(w.subsystem, DEVICE, older, { decision: 'approve' })).status).equal(403);
    should(await w.recipeOf()).equal('Open site.example and sign in');
    should((await call(w.subsystem, DEVICE_PROVED, older, { decision: 'approve' })).status).equal(200);
    should(await w.recipeOf()).equal('Open site.example, then the 2FA page');
  });
});

describe('approving the owner’s own version (#F640)', () => {
  it('makes the owner’s text the recipe in the same act, and the card closes', async () => {
    const w = await world();
    const mine = 'Open site.example, sign in, then type the code from the authenticator';
    const approved = await call(w.subsystem, MACHINE, w.proposalPath, { decision: 'approve', recipe: mine });

    should(approved.status).equal(200);
    should(approved.body.recipe).equal(mine);
    should(approved.body).not.have.property('recipeBy');
    should(await w.recipeOf()).equal(mine);
  });

  it('refuses a version that holds a saved value, and keeps the proposal waiting', async () => {
    const w = await world();
    const accounts = w.subsystem.accounts as NonNullable<SecretSubsystem['accounts']>;
    const refused = await call(w.subsystem, MACHINE, w.proposalPath, { decision: 'approve', recipe: `type ${PASSWORD}` });

    should(refused.status).be.within(400, 499);
    should(await w.recipeOf()).equal('Open site.example and sign in');
    should((await accounts.list()).signIns.find(each => each.id === w.signIn.id)?.proposals).have.length(1);
  });

  it('refuses a recipe on a decline', async () => {
    const w = await world();
    const refused = await call(w.subsystem, MACHINE, w.proposalPath, { decision: 'decline', recipe: 'x' });
    should(refused.status).equal(400);
  });
});
