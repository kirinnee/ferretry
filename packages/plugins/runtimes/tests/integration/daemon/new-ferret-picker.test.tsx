/**
 * THE OWNER'S CASE AT THE PICKER, OVER A REAL DAEMON (PR 2346): a machine whose one runtime is an OLD document that still
 * says `agent: false`, plus logins with no runtime of their own. The REAL composed Runtimes daemon reads a temp config folder
 * and fake logins and derives the roster; the REAL runtime picker New ferret draws (`createNewFerretAccountPanel`) reads it
 * over the daemon's HTTP surface. The old runtime is offered, chosen and ready (nothing about its mode filters it out), a login
 * that needs sign-in yields none, and the page's "No runtime on this machine can run ferrets yet" is never drawn.
 *
 * The start itself (Create in auto mode reaching the runner once, and the pane's `FY_SESSION_MODE`) is
 * `packages/core/kernel/tests/integration/host/launch-mode-runtimes.test.ts`: a page cannot import another package's app half,
 * so the page and the daemon meet there on the route the page POSTs to. Fake values only; nothing reads a real home.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import type { ChosenFerretAccount, NewFerretAccountSlotProps } from '@ferretry/core-ferrets/contract';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { type DaemonImplementation } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { LoginListSchema, ModelCatalogSourcesSchema } from '@ferretry/plugin-logins/contract';
import {
  fakeLoginChanges,
  fakeLoginEnvImport,
  fakeLogins,
  sampleLogin,
} from '@ferretry/plugin-logins/contract/testing';
import { createElement } from 'react';
import { interact, mount } from '../../unit/support/dom.ts';
import { createNewFerretAccountPanel } from '../../../app/views/account-picker-panels.tsx';
import { hostAssembly, runtimesDaemon } from '../../../daemon/index.ts';
import { cleanupWorlds, fleetWorld } from '../../unit/support/fleet-world.ts';

afterEach(cleanupWorlds);

const NEEDS_SIGN_IN = {
  word: 'needs_sign_in',
  label: 'Needs sign-in',
  reason: 'access_current',
  explanation: 'Sign in again.',
  lastCheckInconclusive: false,
} as const;

// The owner's one runtime: an OLD document that still says `agent: false` (read, the field dropped, nothing migrated).
const CONFIG = {
  runtimes: { 'claude-default': { login: 'claude-you', profile: 'default', agent: false } },
  profiles: { default: { contents: ['modelSets/heavy'] } },
  'model-sets': { heavy: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } },
};

// A runtime with no model list is refused (PR 2375), and a runtime derived from a login takes its models from that login's
// catalog. Logins' answer here is the Claude slice a signed-in Claude login reads, so `claude-two` has a model to launch with.
const MODEL_SOURCES = ModelCatalogSourcesSchema.parse({
  catalogs: {
    anthropic: {
      id: 'anthropic',
      origin: 'built-in',
      label: 'Anthropic',
      docs: 'https://example.invalid/anthropic',
      verified: '2027-01-01',
      claude: {
        models: [
          { id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'best', default: true, efforts: ['high'] },
          { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', tier: 'balanced', efforts: [] },
        ],
      },
    },
  },
  presets: [],
});

async function world() {
  const fleet = await fleetWorld();
  const logins = fakeLogins([
    sampleLogin('claude-you', { store: 'ferretry' }),
    sampleLogin('claude-two', { store: 'ferretry' }),
    sampleLogin('claude-down', { store: 'ferretry', status: NEEDS_SIGN_IN }),
  ]);
  logins.setModelSources(MODEL_SOURCES);
  const host = await testHost({
    // The harness the machine "has", so a runtime reads as launchable (nothing is ever executed).
    executables: ['/usr/local/bin/claude', '/usr/local/bin/codex'],
    searchPath: '/usr/local/bin',
    plugins: [
      runtimesDaemon(ctx =>
        hostAssembly({ ...ctx, kernel: { ...ctx.kernel, roots: fleet.roots } } as never),
      ) as DaemonImplementation<any>,
    ],
    fakes: {
      ferrets: new FakeFerrets(),
      logins,
      loginChanges: fakeLoginChanges(),
      loginEnvImport: fakeLoginEnvImport(),
      vault: new FakeVault(),
    },
    gate: new StandInAdmission(() => ownerStanding()),
    config: CONFIG,
    ownerHome: fleet.person,
  });
  /** The picker's client: every call goes through the real daemon's HTTP surface, as the app's client does. */
  const client = {
    call: async <Answer,>(route: string): Promise<Answer> => {
      const [method = 'GET', path = ''] = route.split(' ');
      // The Logins half is a fake here: its list is what the picker's health read asks for.
      if (route === 'GET /v1/logins') return LoginListSchema.parse(await logins.list()) as Answer;
      const answer = await host.request(method, path);
      if (answer.status >= 400) throw new Error(`${route} answered ${answer.status}`);
      return answer.json<Answer>();
    },
  };
  return { host, client };
}

const settle = async (times = 40): Promise<void> => {
  for (let index = 0; index < times; index++) await interact(() => new Promise(resolve => setTimeout(resolve, 25)));
};

describe('the New ferret runtime picker over a real daemon', () => {
  it('lists the old agent:false runtime and one per ready login, and has the old one chosen and ready', async () => {
    const { host, client } = await world();
    try {
      const roster = (await host.request('GET', '/v1/runtimes')).json<{
        runtimes: { name: string; launch: { available: boolean } }[];
      }>().runtimes;
      expect(roster.map(entry => entry.name).toSorted()).toEqual(['claude-default', 'claude-two']);
      expect(roster.every(entry => entry.launch.available)).toBe(true);

      let value = '';
      let chosen: ChosenFerretAccount | null = null;
      const Panel = createNewFerretAccountPanel(client as never);
      const view = (): ReturnType<typeof createElement> => {
        const slot: NewFerretAccountSlotProps = {
          value,
          onValueChange: next => {
            value = next;
          },
          onChosen: next => {
            chosen = next;
          },
          fallbackId: 'runtime',
          labelId: 'runtime-label',
          fallbackPlaceholder: 'e.g. claude-default',
          noAccounts: createElement('p', { 'data-no-accounts': '' }, 'No runtime on this machine can run ferrets yet'),
        };
        return createElement(Panel as never, slot as never);
      };
      const mounted = await mount(view());
      await settle();
      // The picker proposed a runtime; the page (here, this variable) keeps it and draws the picker again.
      await mounted.render(view());
      await settle(10);

      expect(value).toBe('claude-default');
      expect(chosen).not.toBeNull();
      expect((chosen as ChosenFerretAccount | null)?.wrapper).toBe('claude-default');
      // The picker names a runtime in plain words (harness, how it signs in, profile), not by its id.
      expect(mounted.container.textContent).toContain('Claude · Claude.ai sign-in — default profile');
      expect(mounted.container.textContent).toContain('ready');
      expect(mounted.container.textContent).not.toContain('can run ferrets yet');
      await mounted.unmount();
    } finally {
      await host.stop();
    }
  });
});
