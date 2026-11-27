import { describe, expect, test } from 'bun:test';
import type { FerretPurpose } from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId, T0 } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import usage from '../../daemon/index.ts';

// W-09: spend by purpose. A ferret says what it is for when it starts (`fy new --purpose`); Usage groups what it spent by
// that word. A ferret that named none is Unlabelled — never guessed from its transcript — so the groups always add up
// to the whole.

const host = async (ferrets: FakeFerrets) =>
  await testHost({
    plugins: [usage],
    fakes: {
      ferrets,
      conversation: fakeConversation(),
      logins: fakeLogins([sampleLogin('work')]),
      vault: new FakeVault(),
    },
  });

interface Group {
  readonly labels: Readonly<Record<string, string | null>>;
  readonly sessions: number;
  readonly tokens: { readonly value: number | null };
}

const groupsOf = async (h: Awaited<ReturnType<typeof host>>, query: string): Promise<readonly Group[]> => {
  await h.runJob('usage-ingest');
  const answer = await h.request('GET', '/v1/usage/insights', { query: { q: query } });
  return ((await answer.json()) as { readonly results: readonly Group[] }).results;
};

const spend = (ferrets: FakeFerrets, name: string, purpose: FerretPurpose | undefined, tokens: number): void => {
  const id = ferretId(name);
  ferrets.add({ id, state: 'stopped', login: 'work', ...(purpose === undefined ? {} : { purpose }) });
  ferrets.setTurnUsage(id, [{ turn: 1, at: T0, model: 'claude-sonnet-4-5', inputTokens: tokens, outputTokens: 0 }]);
};

describe('W-09 Usage groups spend by what each ferret was started for', () => {
  test('every purpose is its own group, a ferret that named none is Unlabelled, and the groups sum to the total', async () => {
    const ferrets = new FakeFerrets();
    spend(ferrets, 'talker', 'comms', 100);
    spend(ferrets, 'checker', 'review', 200);
    spend(ferrets, 'drafter', 'planning', 400);
    spend(ferrets, 'builder-a', 'implementation', 800);
    spend(ferrets, 'builder-b', 'implementation', 1_600);
    spend(ferrets, 'odd-job', 'other', 3_200);
    spend(ferrets, 'before-the-field', undefined, 6_400);
    const h = await host(ferrets);

    const groups = await groupsOf(h, 'sum by (purpose) {}');
    const total = await groupsOf(h, 'sum {}');

    const byPurpose = Object.fromEntries(
      groups.map(group => [group.labels['purpose'] ?? 'unlabelled', group.tokens.value]),
    );
    expect(byPurpose).toEqual({
      comms: 100,
      review: 200,
      planning: 400,
      implementation: 2_400,
      other: 3_200,
      unlabelled: 6_400,
    });
    expect(groups.reduce((sum, group) => sum + (group.tokens.value ?? 0), 0)).toBe(total[0]?.tokens.value ?? -1);
    expect(groups.reduce((sum, group) => sum + group.sessions, 0)).toBe(7);
    await h.stop();
  });

  test('a purpose can be asked for by name', async () => {
    const ferrets = new FakeFerrets();
    spend(ferrets, 'checker', 'review', 200);
    spend(ferrets, 'builder', 'implementation', 800);
    const h = await host(ferrets);

    const groups = await groupsOf(h, 'sum {purpose=review}');

    expect(groups.map(group => group.tokens.value)).toEqual([200]);
    await h.stop();
  });
});
