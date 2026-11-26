/**
 * A daemon with ONE recipe proposal raised the way production raises it: a ferret calls `account_propose`, the daemon files the
 * proposal and raises its ask through Asks, and the item the board then holds is read back. Nothing here names an ask, a ref or a
 * card. Synthetic ids and text only.
 */
import { expect } from 'bun:test';
import { type AgendaItem, type AskOnScreen, AskOnScreenSchema } from '@ferretry/core-asks/contract';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { ferret, fixedClock, testHost, type TestHost } from '@ferretry/kernel/testing';
import type { SignInSummary } from '../../../contract/routes/index.ts';
import accounts from '../../../daemon/index.ts';

/** The ferret that proposes, and so the board its ask is raised on (unless the asks redirect it). */
export const PROPOSER = 'F1';
export const BASE_RECIPE = 'Original steps';
export const PROPOSED_RECIPE = 'Original steps\nChoose the passkey';
export const PROPOSAL_WHY = 'The page offers a passkey';

export interface ProposedWorld {
  readonly h: TestHost;
  readonly asks: FakeAsks;
  readonly signIn: SignInSummary['id'];
  /** The proposal's ask as its board holds it, read back after the ferret's call. */
  readonly item: AgendaItem;
}

/**
 * What Agenda hands Accounts' renderer for this item: the ref the board kept on it, with the ask's own words and the ferret it is
 * about (`AskOnScreen`). Agenda owns the mapping (`askRendererFor`, proven in its own tests over an item of this shape) and a package
 * reaches another's halves only through the contract, so the join between the two proofs is this contract shape.
 */
export function onScreenOf(item: AgendaItem): AskOnScreen {
  return AskOnScreenSchema.parse({
    ref: item.askRef,
    subject: item.subject,
    ...(item.why === undefined || item.why === null ? {} : { why: item.why }),
    ferret: PROPOSER,
    ferretName: 'judson',
  });
}

export async function proposedWorld(asks: FakeAsks = new FakeAsks()): Promise<ProposedWorld> {
  const h = await testHost({
    plugins: [accounts],
    clock: fixedClock('2026-11-01T12:00:00.000Z'),
    gate: new StandInAdmission(request =>
      request.arrival.kind === 'local' && request.arrival.privileged
        ? ferretStanding(PROPOSER as FerretId)
        : ownerStanding(),
    ),
    uses: { agentControl: { allows: async () => true }, ferrets: { workFolder: async () => ({ folder: '/work/f1' }) } },
    fakes: { vault: new FakeVault(), sealed: new FakeSealedDocuments(), asks, gate: new FakeGate() },
  });
  await h.request('PUT', '/v1/accounts/GITHUB', {
    body: { label: 'GitHub', username: 'octo-fixture', password: 'synthetic-proposed-world-password' },
  });
  const added = await h.request('POST', '/v1/accounts/GITHUB/sign-ins', {
    body: { place: { kind: 'site', domains: ['github.com'], match: ['github.com'] }, recipe: BASE_RECIPE },
  });
  const signIn = added.json<SignInSummary>().id;
  const proposed = await h.tool(
    'account_propose',
    { signIn, recipe: PROPOSED_RECIPE, why: PROPOSAL_WHY },
    { as: ferret(PROPOSER) },
  );
  expect(proposed.isError === true, proposed.text).toBe(false);
  const boards = await asks.snapshots();
  const item = boards.flatMap(board => board.items).at(-1) as AgendaItem;
  return { h, asks, signIn, item };
}
