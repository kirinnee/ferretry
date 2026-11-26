/**
 * G7 / ledger A-31: THE OWNER APPROVES A FERRET'S RECIPE ON ITS ASK CARD, and what they approve is EXACTLY what they were
 * shown. A proposal is served with a `pin` (a SHA-256 over the sign-in, the proposal's id, the recipe it was made against
 * and the recipe it proposes); the card sends that pin back with "Approve", and the daemon refuses an approval whose pin is
 * not the proposal on file (`stale_proposal`, nothing changed). Mounted over the real routes, the real Asks fake and the
 * owner-only grants. Synthetic ids and text only.
 */
import { expect, it } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import { deviceStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { type AuditDraft, FULL_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import type { StateFileDef } from '@ferretry/kernel/contract';
import { ferret, fixedClock, testHost, type TestHost } from '@ferretry/kernel/testing';
import accounts from '../../../daemon/index.ts';
import type { AccountIndexDocument } from '../../../contract/routes/index.ts';
import type { AccountList, SignInSummary } from '../../../contract/routes/index.ts';

const RP = 'rp_0000000000000001';
const OTHER = 'rp_0000000000000002';
const SECRET = 'synthetic-recipe-pin-password';
const indexDef = accounts.manifest.data.state.find(file => file.name === 'accounts') as StateFileDef;
const readIndex = (h: TestHost): AccountIndexDocument => JSON.parse(h.state('accounts').raw(indexDef) ?? '{}');
const plantIndex = (h: TestHost, document: AccountIndexDocument) =>
  h.state('accounts').plant(indexDef, JSON.stringify(document));

const audits: AuditDraft[] = [];
const gate = { audit: async (entry: AuditDraft) => void audits.push(entry) };

async function host(admission?: StandInAdmission, asks = new FakeAsks()) {
  return await testHost({
    plugins: [accounts],
    ...(admission === undefined ? {} : { gate: admission }),
    clock: fixedClock('2026-11-01T12:00:00.000Z'),
    fakes: { vault: new FakeVault(), sealed: new FakeSealedDocuments(), asks, gate },
  });
}

/** One sign-in whose recipe is `Original steps`, with two proposals filed on it and an ask for the first. */
async function proposed(h: TestHost, asks: FakeAsks, text = 'New steps') {
  expect(
    (
      await h.request('PUT', '/v1/accounts/REVIEW', {
        body: { label: 'Review', username: 'fixture', password: SECRET },
      })
    ).status,
  ).toBe(200);
  const added = await h.request('POST', '/v1/accounts/REVIEW/sign-ins', {
    body: { place: { kind: 'site', domains: ['example.com'], match: ['example.com'] }, recipe: 'Original steps' },
  });
  const signIn = added.json<SignInSummary>();
  const ask = await asks.raise({
    source: 'sign-in-approval' as never,
    entry: RP as never,
    ref: { kind: 'recipe-proposal', signIn: signIn.id, proposal: RP },
    kind: 'task',
    subject: 'Recipe change on example.com',
    why: 'Recipe change on example.com',
    raisedBy: { kind: 'daemon' },
    ferret: 'F1' as never,
  });
  const index = readIndex(h);
  const proposal = (id: string, recipe: string) => ({
    id,
    recipe,
    base: 'Original steps',
    why: 'Clearer',
    sessionId: 'F1',
    proposedAt: '2026-11-01T00:00:00.000Z',
  });
  plantIndex(h, {
    ...index,
    signIns: {
      ...index.signIns,
      [signIn.id]: {
        ...index.signIns[signIn.id]!,
        proposals: [{ ...proposal(RP, text), agendaItemId: ask.id }, proposal(OTHER, 'Another steps')],
      },
    },
  });
  return { signIn: signIn.id, ask };
}

const pins = async (h: TestHost) => {
  const listing = (await h.request('GET', '/v1/accounts')).json<AccountList>();
  return Object.fromEntries(
    listing.signIns.flatMap(signIn => (signIn.proposals ?? []).map(proposal => [proposal.id, proposal.pin])),
  );
};

it('G7 serves each proposal with a pin that names that proposal alone', async () => {
  const asks = new FakeAsks();
  const h = await host(undefined, asks);
  try {
    await proposed(h, asks);
    const served = await pins(h);
    expect(served[RP]).toMatch(/^[0-9a-f]{64}$/u);
    expect(served[OTHER]).toMatch(/^[0-9a-f]{64}$/u);
    expect(served[RP]).not.toBe(served[OTHER]);
  } finally {
    await h.stop();
  }
});

it('G7 approving with the pin it was shown applies exactly that recipe and closes its ask', async () => {
  const asks = new FakeAsks();
  const h = await host(undefined, asks);
  try {
    const { signIn, ask } = await proposed(h, asks);
    const pin = (await pins(h))[RP];
    const response = await h.request('POST', `/v1/accounts/sign-ins/${signIn}/recipe/proposals/${RP}`, {
      body: { decision: 'approve', pin },
    });
    expect(response.status).toBe(200);
    expect(response.json<SignInSummary>().recipe).toBe('New steps');
    expect((await asks.get(ask))?.state).toBe('closed');
  } finally {
    await h.stop();
  }
});

it('G7 an approval pinned to a different proposal, or to a different text, is refused and changes nothing', async () => {
  const asks = new FakeAsks();
  const h = await host(undefined, asks);
  try {
    const { signIn, ask } = await proposed(h, asks);
    const shown = await pins(h);
    const path = `/v1/accounts/sign-ins/${signIn}/recipe/proposals/${RP}`;
    for (const pin of [shown[OTHER], '0'.repeat(64)]) {
      const refused = await h.request('POST', path, { body: { decision: 'approve', pin } });
      expect(refused.status).toBe(409);
      expect(refused.json<{ code: string }>().code).toBe('stale_proposal');
    }
    // The text on file changes after the owner was shown it: the pin they hold no longer names what is on file.
    const index = readIndex(h);
    const record = index.signIns[signIn]!;
    plantIndex(h, {
      ...index,
      signIns: {
        ...index.signIns,
        [signIn]: {
          ...record,
          proposals: (record.proposals ?? []).map(each =>
            each.id === RP ? { ...each, recipe: 'Swapped steps' } : each,
          ),
        },
      },
    });
    const swapped = await h.request('POST', path, { body: { decision: 'approve', pin: shown[RP] } });
    expect(swapped.status).toBe(409);
    expect(readIndex(h).signIns[signIn]?.recipe).toBe('Original steps');
    expect(readIndex(h).signIns[signIn]?.proposals?.length).toBe(2);
    expect((await asks.get(ask))?.state).toBe('open');
  } finally {
    await h.stop();
  }
});

it('G7 a pin is not a way to decline: a decline needs none and carries no pin check', async () => {
  const asks = new FakeAsks();
  const h = await host(undefined, asks);
  try {
    const { signIn } = await proposed(h, asks);
    const declined = await h.request('POST', `/v1/accounts/sign-ins/${signIn}/recipe/proposals/${RP}`, {
      body: { decision: 'decline' },
    });
    expect(declined.status).toBe(200);
    expect(declined.json<SignInSummary>().recipe).toBe('Original steps');
  } finally {
    await h.stop();
  }
});

it('G7 a malformed pin is refused before anything is read', async () => {
  const asks = new FakeAsks();
  const h = await host(undefined, asks);
  try {
    const { signIn } = await proposed(h, asks);
    const response = await h.request('POST', `/v1/accounts/sign-ins/${signIn}/recipe/proposals/${RP}`, {
      body: { decision: 'approve', pin: 'not-a-hash' },
    });
    expect(response.status).toBe(400);
    expect(readIndex(h).signIns[signIn]?.recipe).toBe('Original steps');
  } finally {
    await h.stop();
  }
});

it('G7 only the owner answers: a ferret is refused, and a device without secrets configure is refused', async () => {
  const asks = new FakeAsks();
  const plain = await host(undefined, asks);
  try {
    const { signIn } = await proposed(plain, asks);
    const pin = (await pins(plain))[RP];
    const path = `/v1/accounts/sign-ins/${signIn}/recipe/proposals/${RP}`;
    const asFerret = await plain.request('POST', path, { body: { decision: 'approve', pin }, as: ferret('F1') });
    expect(asFerret.status).toBe(403);
    expect(readIndex(plain).signIns[signIn]?.recipe).toBe('Original steps');
  } finally {
    await plain.stop();
  }

  // A paired device the owner has not granted `secrets` configure to: it may read, and may not decide.
  let remote = false;
  const narrow = { ...FULL_DEVICE_GRANTS, secrets: { use: true, configure: false } };
  const admission = new StandInAdmission(() => (remote ? deviceStanding('device-g7', narrow, true) : ownerStanding()));
  const guarded = await host(admission, asks);
  try {
    const { signIn } = await proposed(guarded, asks);
    remote = true;
    const response = await guarded.request('POST', `/v1/accounts/sign-ins/${signIn}/recipe/proposals/${RP}`, {
      body: { decision: 'approve', pin: '0'.repeat(64) },
    });
    expect(response.status).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('grant_device_not_granted');
    expect(readIndex(guarded).signIns[signIn]?.recipe).toBe('Original steps');
  } finally {
    await guarded.stop();
  }
});

it('G7 an approval is audited by ids only: the audit never holds the recipe or the pin', async () => {
  audits.length = 0;
  const asks = new FakeAsks();
  const h = await host(undefined, asks);
  try {
    const { signIn } = await proposed(h, asks, 'Click Continue, type nothing secret');
    const pin = (await pins(h))[RP];
    const response = await h.request('POST', `/v1/accounts/sign-ins/${signIn}/recipe/proposals/${RP}`, {
      body: { decision: 'approve', pin },
    });
    expect(response.status).toBe(200);
    const written = JSON.stringify(audits);
    expect(written).not.toContain('Click Continue');
    expect(written).not.toContain(pin as string);
    expect(written).not.toContain(SECRET);
    expect(h.logs.map(line => JSON.stringify(line)).join('\n')).not.toContain('Click Continue');
  } finally {
    await h.stop();
  }
});
