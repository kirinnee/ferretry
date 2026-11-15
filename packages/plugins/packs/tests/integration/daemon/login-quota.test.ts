import { describe, expect, test } from 'bun:test';
import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import type { LoginsApi } from '@ferretry/plugin-logins/contract';
import { LoginQuotaFacts } from '../../../daemon/adapters/login-quota.ts';

const NOW = 1_000_000;

type Limit = { readonly notice: string; readonly spend: boolean; readonly retryAt?: number };
interface Seen {
  readonly id: string;
  readonly login?: string;
  readonly state?: string;
  readonly limit?: Limit | 'throws';
}

/** The Ferrets port, narrowed to what Packs reads: `list()` names the ferrets, `prompt(id)` answers each one's limit. */
function ferretsOf(seen: readonly Seen[], listFails = false) {
  const asked: string[] = [];
  return {
    asked,
    port: {
      list: async () => {
        if (listFails) throw new Error('ferrets are not listing');
        return seen.map(({ id, login, state }) => ({ id, login, state: state ?? 'idle' }) as unknown as FerretSummary);
      },
      prompt: async (id: string) => {
        asked.push(id);
        const found = seen.find(ferret => ferret.id === id)?.limit;
        if (found === 'throws') throw new Error('no prompt for that ferret');
        return found === undefined ? {} : { limit: found };
      },
    } as never,
  };
}
const facts = (ferrets: ReturnType<typeof ferretsOf>['port']) =>
  new LoginQuotaFacts(
    () => undefined,
    () => ferrets,
    () => NOW,
  );

describe('what Packs reads of each login', () => {
  test('lists the logins the Logins plugin holds, and none while that plugin is off', async () => {
    const row = { id: 'work' } as never;
    const on = new LoginQuotaFacts(() => ({ list: async () => ({ logins: [row] }) }) as unknown as LoginsApi);
    expect(await on.credentials()).toEqual([row]);
    expect(await new LoginQuotaFacts(() => undefined).credentials()).toEqual([]);
  });
});

describe('the limits the panes announce', () => {
  test('are none without a Ferrets port, or one that cannot be asked for a prompt', async () => {
    expect((await new LoginQuotaFacts(() => undefined).paneLimits()).size).toBe(0);
    const noPrompt = new LoginQuotaFacts(
      () => undefined,
      () => ({ list: async () => [] }) as never,
    );
    expect((await noPrompt.paneLimits()).size).toBe(0);
  });

  test('are none, rather than a failed read, when the ferrets cannot be listed', async () => {
    const { port } = ferretsOf([], true);
    expect((await facts(port).paneLimits()).size).toBe(0);
  });

  test('come only from live ferrets that run on a login, and are asked of each of those once', async () => {
    const { port, asked } = ferretsOf([
      { id: 'live', login: 'work', limit: { notice: 'monthly spend limit', spend: true, retryAt: NOW + 5000 } },
      { id: 'ended', login: 'work', state: 'stopped', limit: { notice: 'old', spend: false, retryAt: NOW + 9000 } },
      { id: 'loginless', limit: { notice: 'no login', spend: false } },
    ]);

    const limits = await facts(port).paneLimits();

    expect(asked).toEqual(['live']);
    expect(limits).toEqual(new Map([['work', { notice: 'monthly spend limit', spend: true, retryAt: NOW + 5000 }]]));
  });

  test('keep a limit with no reset time as it was said, and drop one whose reset has passed', async () => {
    const { port } = ferretsOf([
      { id: 'a', login: 'open-ended', limit: { notice: 'hit it', spend: false } },
      { id: 'b', login: 'over', limit: { notice: 'reset', spend: false, retryAt: NOW } },
    ]);

    expect(await facts(port).paneLimits()).toEqual(new Map([['open-ended', { notice: 'hit it', spend: false }]]));
  });

  test('lose one ferret’s evidence when its read fails, never the others’', async () => {
    const { port } = ferretsOf([
      { id: 'a', login: 'work', limit: 'throws' },
      { id: 'b', login: 'home', limit: { notice: 'hit it', spend: false, retryAt: NOW + 1 } },
      { id: 'c', login: 'quiet' },
    ]);

    expect(await facts(port).paneLimits()).toEqual(
      new Map([['home', { notice: 'hit it', spend: false, retryAt: NOW + 1 }]]),
    );
  });

  test('are the latest reset where several ferrets share a login, and an open end outlasts a dated one', async () => {
    const dated = (id: string, retryAt: number): Seen => ({
      id,
      login: 'shared',
      limit: { notice: `until ${retryAt}`, spend: false, retryAt },
    });
    const later = ferretsOf([dated('a', NOW + 10), dated('b', NOW + 30), dated('c', NOW + 20)]);
    expect((await facts(later.port).paneLimits()).get('shared')?.retryAt).toBe(NOW + 30);

    const openLast = ferretsOf([
      dated('a', NOW + 10),
      { id: 'b', login: 'shared', limit: { notice: 'open', spend: true } },
    ]);
    expect((await facts(openLast.port).paneLimits()).get('shared')).toEqual({ notice: 'open', spend: true });

    const openFirst = ferretsOf([
      { id: 'a', login: 'shared', limit: { notice: 'open', spend: true } },
      dated('b', NOW + 10),
    ]);
    expect((await facts(openFirst.port).paneLimits()).get('shared')).toEqual({ notice: 'open', spend: true });
  });

  test('read the clock when none is injected', async () => {
    const { port } = ferretsOf([
      { id: 'a', login: 'work', limit: { notice: 'far off', spend: false, retryAt: Date.now() + 3_600_000 } },
      { id: 'b', login: 'past', limit: { notice: 'long gone', spend: false, retryAt: 1 } },
    ]);
    const limits = await new LoginQuotaFacts(
      () => undefined,
      () => port,
    ).paneLimits();
    expect([...limits.keys()]).toEqual(['work']);
  });
});
