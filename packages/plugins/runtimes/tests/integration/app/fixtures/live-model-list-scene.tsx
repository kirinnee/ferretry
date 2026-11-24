/**
 * The browser entry for "the model picker shows the login's live list" (U6b), over Ferrets' REAL `NewFerretPage` with
 * Runtimes' REAL runtime picker in its slot (no stand-in on either side), over one fake daemon that answers from memory:
 *
 *   ?state=fresh|stale   the list was read 2 hours ago / 3 days ago (the provider could not be asked again)
 *   &refresh=1|0         "Refresh list" is offered (a device that may configure) / not (a limited device)
 *   &theme=<family>-<mode>
 *
 * The page keeps what the picker tells it in state (`onChosen: setChosenRuntime`), so a picker that told it again on every
 * draw would never stop drawing: the scene is the proof that it does. Every call is recorded on `window.__calls`.
 *
 * The ids are the DeepSeek catalog's two models and the ids DeepSeek's `/models` lists today (models.dev snapshot), so the
 * picker shows one curated model the list lacks and two models the catalog has not reviewed.
 */
import { createRoot } from 'react-dom/client';
import type { NewFerretAccountSlotProps } from '@ferretry/core-ferrets/contract';
import type { ComponentType } from 'react';
import { NewFerretPage } from '../../../../../../core/ferrets/app/features/new-ferret/new-ferret-page.tsx';
import type { FerretsClient } from '../../../../../../core/ferrets/app/lib/client.ts';
import { createNewFerretAccountPanel } from '../../../../app/views/account-picker-panels.tsx';
import type { LiveRuntimesClient } from '../../../../app/lib/client.ts';
import { loginList, loginView, runtimeCatalog, runtimeView } from '../../../unit/app/support/picker.ts';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') ?? 'studio-light';
const root = document.documentElement;
root.dataset.theme = theme;
root.dataset.palette = theme.split('-')[0] ?? 'studio';
root.dataset.mode = theme.endsWith('dark') ? 'dark' : 'light';
root.dataset.style = 'studio';
const stale = params.get('state') === 'stale';
const canRefresh = params.get('refresh') !== '0';

const LOGIN = 'login-deepseek-a';
const choice = { efforts: [], available: true } as const;
const CATALOG = runtimeCatalog(
  runtimeView({
    wrapper: 'deepseek-a',
    models: {
      catalog: {
        id: 'deepseek',
        label: 'DeepSeek',
        origin: 'built-in',
        customIds: true,
        docs: 'docs/model-catalog.md',
      },
      default: 'deepseek-v4-pro',
      choices: [
        { ...choice, id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', tier: 'best', context: 1_000_000 },
        { ...choice, id: 'deepseek-flash', label: 'DeepSeek Flash', tier: 'fast', context: 1_000_000 },
      ],
    },
  }),
);
const READ_AT = Date.now() - (stale ? 3 * 86_400_000 : 2 * 3_600_000);
const answer = (): unknown => ({
  loginId: LOGIN,
  outcome: stale ? 'kept' : 'current',
  list: {
    fetchedAt: new Date(READ_AT).toISOString(),
    complete: true,
    ids: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
  },
});

interface Recorded {
  route: string;
}
const calls: Recorded[] = [];
(window as unknown as { __calls: Recorded[] }).__calls = calls;

const client = {
  subscribe: () => () => undefined,
  call: async <Answer,>(route: string): Promise<Answer> => {
    calls.push({ route });
    if (route === 'GET /v1/runtimes') return CATALOG as Answer;
    if (route === 'GET /v1/logins') return loginList(loginView(LOGIN)) as Answer;
    if (route === 'GET /v1/grants')
      return {
        capabilities: [
          {
            capability: 'fleet',
            configure: canRefresh,
            configureRefusal: canRefresh ? 'granted' : 'device-not-granted',
          },
        ],
      } as Answer;
    if (route === 'POST /v1/logins/:loginId/model-list/refresh') return answer() as Answer;
    if (route === 'POST /v1/logins/:loginId/model-list/force') return answer() as Answer;
    if (route === 'GET /v1/ferrets') return [] as Answer;
    throw new Error(`no route ${route}`);
  },
};

const Panel = createNewFerretAccountPanel(
  client as unknown as LiveRuntimesClient,
) as unknown as ComponentType<NewFerretAccountSlotProps>;
const AccountSlot = ({ slot }: { readonly slot: NewFerretAccountSlotProps }) => <Panel {...slot} />;

const mountPoint = document.getElementById('root');
if (mountPoint !== null)
  createRoot(mountPoint).render(
    <div data-scene-ready="">
      <NewFerretPage
        AccountSlot={AccountSlot}
        client={client as unknown as FerretsClient}
        daemon="fake"
        onNavigate={() => undefined}
      />
    </div>,
  );
