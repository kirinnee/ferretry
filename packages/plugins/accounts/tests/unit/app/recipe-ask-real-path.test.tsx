/**
 * G7 / ledger A-31, REVIEW ITEM 1 (Accounts' half): a ferret's recipe proposal, made the way production makes it, reaches the
 * owner's form. Nothing here is a hand-made ref: a ferret proposes through `account_propose`, the daemon raises the ask through
 * Asks, and the item the board holds is read back. Its `askRef` (kept by the Asks port, proven over the real engine in Asks'
 * `asks-port.test.ts`) is the value Agenda hands this renderer (`AskOnScreen`; Agenda's own tests prove the chat and the Inbox
 * both build it from such an item). The form is drawn by the Accounts renderer over the real owner routes, and Approve and Decline
 * are pressed. Synthetic ids and text only.
 */
import { describe, expect, it } from 'bun:test';
import type { TestHost } from '@ferretry/kernel/testing';
import type { SignInSummary } from '../../../contract/routes/index.ts';
import { signInApprovalCard } from '../../../app/surfaces.tsx';
import { mount } from '../../support/app/dom.ts';
import { click, settle } from '../../support/app/dom-form.ts';
import {
  BASE_RECIPE,
  onScreenOf,
  PROPOSAL_WHY,
  PROPOSED_RECIPE,
  PROPOSER,
  proposedWorld,
} from '../../support/daemon/proposed-world.ts';

/** The app's client, answering from the real mounted routes of the accounts daemon. */
const clientOver = (h: TestHost) => ({
  call: async (
    route: string,
    init?: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown },
  ) => {
    const [method = 'GET', template = ''] = route.split(' ');
    const path = template.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, (_, name: string) =>
      encodeURIComponent(init?.params?.[name] ?? `:${name}`),
    );
    const query = init?.query === undefined ? '' : `?${new URLSearchParams(init.query).toString()}`;
    const response = await h.request(
      method as 'GET',
      `${path}${query}`,
      init?.body === undefined ? {} : { body: init.body },
    );
    if (response.status >= 400) throw new Error(`${route} answered ${String(response.status)}`);
    return response.json();
  },
});

const button = (container: ParentNode, name: 'approve' | 'decline') =>
  container.querySelector<HTMLElement>(`[data-recipe-proposal-${name}]`);

const recipeAfter = async (h: TestHost, signIn: string) => {
  const list = (await h.request('GET', '/v1/accounts')).json<{ signIns: SignInSummary[] }>();
  return list.signIns.find(each => each.id === signIn);
};

describe('a real recipe proposal on its ask item', () => {
  it('carries the ref the Accounts renderer draws, and Approve applies exactly the proposed recipe and closes the ask', async () => {
    const { h, asks, signIn, item } = await proposedWorld();
    try {
      expect(item.askRef).toMatchObject({ kind: 'recipe-proposal', signIn });
      const mounted = await mount(<>{signInApprovalCard(clientOver(h) as never, onScreenOf(item), undefined)}</>);
      await settle();
      try {
        expect(mounted.container.textContent).toContain(`The ferret says: ${PROPOSAL_WHY}`);
        expect(button(mounted.container, 'decline')).not.toBeNull();
        await click(button(mounted.container, 'approve'));
        await settle();
      } finally {
        await mounted.unmount();
      }
      expect((await recipeAfter(h, signIn))?.recipe).toBe(PROPOSED_RECIPE);
      expect((await asks.get({ ferret: PROPOSER, id: item.id as never }))?.state).toBe('closed');
    } finally {
      await h.stop();
    }
  });

  it('Decline leaves the recipe as it was and closes the ask', async () => {
    const { h, asks, signIn, item } = await proposedWorld();
    try {
      const mounted = await mount(<>{signInApprovalCard(clientOver(h) as never, onScreenOf(item), undefined)}</>);
      await settle();
      try {
        await click(button(mounted.container, 'decline'));
        await settle();
      } finally {
        await mounted.unmount();
      }
      const kept = await recipeAfter(h, signIn);
      expect(kept?.recipe).toBe(BASE_RECIPE);
      expect(kept?.proposals ?? []).toEqual([]);
      expect((await asks.get({ ferret: PROPOSER, id: item.id as never }))?.state).toBe('closed');
    } finally {
      await h.stop();
    }
  });
});
