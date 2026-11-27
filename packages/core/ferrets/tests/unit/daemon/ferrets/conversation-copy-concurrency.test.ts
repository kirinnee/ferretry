import { expect, test } from 'bun:test';
import { DEFAULT_GATE_SECURITY } from '@ferretry/core-gate/contract';
import { deviceStanding, FakeStepUpWitness } from '@ferretry/core-gate/contract/testing';
import { ok } from '@ferretry/std';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { fakeLaunchRoots, fakeStageOwner, host } from './route-fixture.ts';

for (const window of [0, 15]) {
  test(`E-255 concurrent copy requests respect a ${window}-minute step-up window`, async () => {
    const subject = { deviceId: 'phone', appSession: 'app' };
    const proofs = new FakeStepUpWitness({
      nowMs: () => 0,
      settings: () => ({ ...DEFAULT_GATE_SECURITY, unlockOnOpen: false, stepUpWindowMinutes: window }),
    });
    proofs.grant(subject);
    const bothEntered = Promise.withResolvers<void>();
    let entered = 0;
    const staged: string[] = [];
    const harness = new FakeHarness().honestHistory();
    const h = await host([], {
      harness,
      runner: new FakeRunner(),
      standing: () => ({
        ...deviceStanding('phone'),
        governance: { governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) },
        // Both requests carry the same admitted verdict. Only an atomic claim can distinguish their current rights.
        spendStepUp: () => proofs.spend(subject),
        claimStepUp: () => {
          if (!proofs.held(subject)) return false;
          proofs.spend(subject);
          return true;
        },
      }),
      plugins: [
        fakeLaunchRoots({
          roots: async () => {
            entered += 1;
            if (entered === 2) bothEntered.resolve();
            await bothEntered.promise;
            return ['/work'];
          },
        }),
        fakeStageOwner({
          stage: async ({ conversation }) => {
            staged.push(conversation);
            await harness.importConversation({ id: conversation, source: `projects/test/${conversation}.jsonl` });
            return ok({ release: () => undefined });
          },
        }),
      ],
    });
    const requests = ['first', 'second'].map(id =>
      h.request('POST', '/v1/ferrets', {
        headers: { 'x-fy-request-id': `concurrent-copy-${id}` },
        body: { folder: '/work/a', harnessConversation: `history-${id}` },
      }),
    );
    const results = await Promise.all(requests);
    expect(entered).toBe(2);
    expect(results.filter(result => result.status === 201)).toHaveLength(window === 0 ? 1 : 2);
    expect(results.filter(result => result.status === 403)).toHaveLength(window === 0 ? 1 : 0);
    expect(staged).toHaveLength(window === 0 ? 1 : 2);
  });
}
