/**
 * G7 / ledger A-31 review items 2 and 3, over the real routes, the real `account_propose` tool and the Asks fake.
 *
 * 2. A PIN NAMES WHERE IT WRITES. The pin covers the sign-in's account, place and method as well as the proposal's text, and it
 *    is checked on the same snapshot the approval is applied to, so a sign-in retargeted after the card was drawn refuses the
 *    old card's pin (`stale_proposal`) and writes nothing.
 * 3. A REDIRECTED PROPOSAL CLOSES ITS OWN ASK. A sub-ferret's ask may land on its lead's board; the proposal keeps that board
 *    with the id, and settling it closes THAT ask and no other.
 *
 * Synthetic ids and text only.
 */
import { expect, it } from 'bun:test';
import { type AskDraft, type AskRef } from '@ferretry/core-asks/contract';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type { TestHost } from '@ferretry/kernel/testing';
import type { AccountList, SignInSummary } from '../../../contract/routes/index.ts';
import {
  BASE_RECIPE,
  PROPOSAL_WHY,
  PROPOSED_RECIPE,
  PROPOSER,
  proposedWorld,
} from '../../support/daemon/proposed-world.ts';

const LEAD = 'LEAD';

/** Asks that lands every ask on the lead's board, as a daemon raise about a sub-ferret does. */
class RedirectingAsks extends FakeAsks {
  override async raise(ask: AskDraft): Promise<AskRef> {
    return await super.raise({ ...ask, ferret: LEAD as never });
  }
}

async function world(asks: FakeAsks = new FakeAsks()) {
  const { h, signIn } = await proposedWorld(asks);
  return { h, signIn };
}

const waiting = async (h: TestHost, signIn: string) => {
  const list = (await h.request('GET', '/v1/accounts')).json<AccountList>();
  const proposal = list.signIns.find(each => each.id === signIn)?.proposals?.[0];
  return { pin: proposal?.pin as string, id: proposal?.id as string };
};
const decide = async (h: TestHost, signIn: string, id: string, body: unknown) =>
  await h.request('POST', `/v1/accounts/sign-ins/${signIn}/recipe/proposals/${id}`, { body });
const recipeOf = async (h: TestHost, signIn: string) =>
  (
    (await h.request('GET', '/v1/accounts'))
      .json<AccountList>()
      .signIns.find(each => each.id === signIn) as SignInSummary
  ).recipe;

it('G7 a sign-in retargeted after the card was drawn refuses the old card’s pin and writes nothing (409 stale_proposal)', async () => {
  const { h, signIn } = await world();
  try {
    const shown = await waiting(h, signIn);
    // The owner (or anyone with configure) moves the sign-in to another place; its id, the proposal and the base recipe are unchanged.
    const moved = await h.request('PUT', `/v1/accounts/sign-ins/${signIn}`, {
      body: { place: { kind: 'site', domains: ['elsewhere.example'], match: ['elsewhere.example'] } },
    });
    expect(moved.status).toBe(200);
    const refused = await decide(h, signIn, shown.id, { decision: 'approve', pin: shown.pin });
    expect(refused.status).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('stale_proposal');
    expect(await recipeOf(h, signIn)).toBe(BASE_RECIPE);
    // The card the owner is shown NOW carries a new pin, which is what approves the retargeted sign-in.
    const reshown = await waiting(h, signIn);
    expect(reshown.pin).not.toBe(shown.pin);
    expect((await decide(h, signIn, reshown.id, { decision: 'approve', pin: reshown.pin })).status).toBe(200);
    expect(await recipeOf(h, signIn)).toBe(PROPOSED_RECIPE);
  } finally {
    await h.stop();
  }
});

it('G7 an approval whose sign-in is retargeted between the check and the write is judged on the snapshot it applies to', async () => {
  const { h, signIn } = await world();
  try {
    const shown = await waiting(h, signIn);
    // Fired together: the retarget and the pinned approval race. Whichever order the store serialises them in, an approval
    // that lands has the pin of the place it wrote to, and one that does not leaves the recipe as it was.
    const [moved, approved] = await Promise.all([
      h.request('PUT', `/v1/accounts/sign-ins/${signIn}`, {
        body: { place: { kind: 'site', domains: ['raced.example'], match: ['raced.example'] } },
      }),
      decide(h, signIn, shown.id, { decision: 'approve', pin: shown.pin }),
    ]);
    expect(moved.status).toBe(200);
    const recipe = await recipeOf(h, signIn);
    if (approved.status === 200) expect(recipe).toBe(PROPOSED_RECIPE);
    else {
      expect(approved.status).toBe(409);
      expect(recipe).toBe(BASE_RECIPE);
    }
  } finally {
    await h.stop();
  }
});

it('G7 a proposal whose ask landed on another board closes that ask on Approve and on Decline, and no other', async () => {
  for (const decision of ['approve', 'decline'] as const) {
    const asks = new RedirectingAsks();
    // An unrelated ask on the PROPOSER's board that takes the id the redirected ask gets on the lead's board (A1 on each).
    await FakeAsks.prototype.raise.call(asks, {
      source: 'ferret',
      ref: {},
      entry: 'unrelated',
      kind: 'yesno',
      subject: 'Ship it?',
      why: 'Because.',
      raisedBy: { kind: 'ferret', ferret: PROPOSER },
      ferret: PROPOSER,
    } as never);
    const { h, signIn } = await world(asks);
    try {
      const own = { ferret: PROPOSER, id: 'A1' } as unknown as AskRef;
      const landed = { ferret: LEAD, id: 'A1' } as unknown as AskRef;
      expect((await asks.get(own))?.state).toBe('open');
      expect((await asks.get(landed))?.state).toBe('open');
      const shown = await waiting(h, signIn);
      const answered = await decide(h, signIn, shown.id, {
        decision,
        ...(decision === 'approve' ? { pin: shown.pin } : {}),
      });
      expect(answered.status).toBe(200);
      expect((await asks.get(landed))?.state).toBe('closed');
      expect((await asks.get(own))?.state).toBe('open');
    } finally {
      await h.stop();
    }
  }
});

it('G7 the ask carries a fixed sentence, never the recipe lines or the ferret’s reason (a ferret can read other asks)', async () => {
  const { h, item } = await proposedWorld();
  try {
    expect(item.context).toBe('A ferret proposed a sign-in recipe change — review it here');
    const everything = JSON.stringify(item);
    expect(everything).not.toContain('Choose the passkey');
    expect(everything).not.toContain(PROPOSAL_WHY);
  } finally {
    await h.stop();
  }
});
