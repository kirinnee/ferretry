/** The browser's half of the input bridge: one card this build cannot read must not hide the others. */

import { describe, expect, it } from 'bun:test';
import { LOGIN_RECIPE_MAX_LENGTH } from '@ferretry/protocol';
import { decideRecipeProposal, readInputRequest } from '../../src/lib/input-api.ts';
import { list, PROPOSAL, SI_GITHUB } from '../support/accounts-fixtures.ts';
import { fakeClient, request } from '../support/input-fixtures.ts';

const clientAnswering = (requests: readonly unknown[]) =>
  ({
    request: async (_path: string, schema: { parse: (value: unknown) => unknown }) => schema.parse({ requests }),
  }) as never;

describe('reading the open input requests of a session', () => {
  it('finds the card asked for, even when another card in the list is one this build cannot read', async () => {
    const wanted = request({ id: 'cd'.repeat(16) });
    const found = await readInputRequest(
      clientAnswering([{ id: 'not-a-card', from: 'a newer daemon' }, wanted]),
      wanted.sessionId,
      wanted.id,
    );
    expect(found).toMatchObject({ id: wanted.id });
  });

  it('says nothing is there when the card is no longer listed', async () => {
    const found = await readInputRequest(clientAnswering([{ odd: true }]), 'sess-1', 'gone');
    expect(found).toBeUndefined();
  });
});

describe('a card this build cannot read', () => {
  it('is reported as unreadable, not as gone, so the owner is told to update', async () => {
    const found = await readInputRequest(
      clientAnswering([{ id: 'ab'.repeat(16), from: 'a newer daemon' }]),
      'sess-1',
      'ab'.repeat(16),
    );
    expect(found).toBe('unreadable');
  });
});

describe('answering a recipe proposal', () => {
  const path = `/v1/accounts/sign-ins/${SI_GITHUB}/recipe/proposals/${PROPOSAL}`;

  it('posts the decision to the proposal’s route and reads the sign-in back', async () => {
    const fake = fakeClient(() => list().signIns[0]);
    const summary = await decideRecipeProposal(fake.client, SI_GITHUB, PROPOSAL, {
      decision: 'approve',
      recipe: 'Open the page.',
    });
    expect(fake.calls).toEqual([{ path, method: 'POST', body: { decision: 'approve', recipe: 'Open the page.' } }]);
    expect(summary.id).toBe(SI_GITHUB);
  });

  it('refuses to send a recipe the daemon would not accept, without a call', async () => {
    const fake = fakeClient(() => list().signIns[0]);
    await expect(
      decideRecipeProposal(fake.client, SI_GITHUB, PROPOSAL, {
        decision: 'approve',
        recipe: 'x'.repeat(LOGIN_RECIPE_MAX_LENGTH + 1),
      }),
    ).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });
});
