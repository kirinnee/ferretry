/**
 * Settings › Web search INSIDE THE REAL SETTINGS SHELL: the plugin's real tab declaration and its real body over a fake
 * machine. No daemon, no network. `/d/ws/settings/search/search?theme=<family>-<mode>`, and
 *   ?state=off|ready   a machine with no provider listed, or Serper, Brave and Exa listed with 37 of 200 searches used
 *   ?held=1            the machine holds an edit for the owner (a setup is answered "held")
 * Everything on screen is made up. The fake records on `window.__fake` the NAMES, lists and lengths that reached it,
 * never a key.
 */
import manifest from '../../../../manifest.ts';
import { SearchSettings } from '../../../../app/settings.tsx';
import { renderSettingsShell } from '@ferretry/app/testing/settings-shell';
import { SEARCH_PROVIDERS, type SearchProviderId } from '../../../../contract/index.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const fake = {
  puts: [] as { name: string; length: number }[],
  setups: [] as unknown[],
  tests: [] as string[],
};
(window as unknown as { __fake: typeof fake }).__fake = fake;

interface FakeTest {
  provider: SearchProviderId;
  ok: boolean;
  code: string;
  message: string;
  latencyMs: number;
  at: string;
}

const ready = params.get('state') === 'ready';
const state = {
  providers: (ready ? (['serper', 'brave', 'exa'] as const) : []).map(provider => ({
    provider,
    ...(provider === 'brave'
      ? {
          lastTest: {
            provider,
            ok: false,
            code: 'rate_limited',
            message: 'The provider is rate limiting or busy right now. Try again in a minute.',
            latencyMs: 240,
            at: '2026-11-24T08:30:00.000Z',
          } satisfies FakeTest,
        }
      : {}),
  })) as { provider: SearchProviderId; lastTest?: FakeTest }[],
  usedToday: ready ? 37 : 0,
  dailyCap: 200,
  held: [] as string[],
};

const client = {
  call: async (route: string, init?: { body?: unknown }): Promise<unknown> => {
    if (route === 'GET /v1/web-search') return structuredClone(state);
    if (route === 'POST /v1/secrets') {
      const body = init?.body as { name: string; value: string };
      fake.puts.push({ name: body.name, length: body.value.length });
      return {};
    }
    if (route === 'PUT /v1/web-search/setup') {
      const body = init?.body as { providers?: SearchProviderId[]; dailyCap?: number };
      fake.setups.push(body);
      if (params.get('held') === '1') {
        const held = [
          body.providers === undefined
            ? 'the daily search limit goes up from 200 to 500'
            : `names the secret ${SEARCH_PROVIDERS[body.providers.at(-1) ?? 'serper'].secretName}, which only the owner may add to a configuration`,
        ];
        state.held = held;
        return { outcome: 'held', held };
      }
      if (body.providers !== undefined)
        state.providers = body.providers.map(
          provider => state.providers.find(entry => entry.provider === provider) ?? { provider },
        );
      if (body.dailyCap !== undefined) state.dailyCap = body.dailyCap;
      return { outcome: 'applied', held: [] };
    }
    if (route === 'POST /v1/web-search/test') {
      const { provider } = (init?.body ?? {}) as { provider: SearchProviderId };
      fake.tests.push(provider);
      state.usedToday += 1;
      const entry = state.providers.find(item => item.provider === provider);
      if (entry !== undefined)
        entry.lastTest = {
          provider,
          ok: true,
          code: 'ok',
          message: 'The key works.',
          latencyMs: 412,
          at: '2026-11-24T09:00:00.000Z',
        };
      return entry?.lastTest;
    }
    throw new Error(`the fake has no route ${route}`);
  },
};

renderSettingsShell({ manifest, bodies: { search: () => <SearchSettings client={client as never} /> } });
