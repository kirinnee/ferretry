/**
 * Browser entry for O8-9, "a ready login is a runtime": the REAL runtime picker New ferret draws (Runtimes' panel, in the
 * field New ferret gives it) over a daemon that answers from memory, and the REAL Advanced "Add a runtime" form. Fake data, no network.
 *
 *   ?view=new|advanced|runtimes   the New ferret runtime field (default), the Advanced form or the Runtimes tab
 *   ?host=1              the logins are the person's own terminal sign-in (`store: host`), each runtime reading a model catalog (O12 S2)
 *   ?logins=<n>          ready Claude logins, one runtime each (default 4: atomi, llm1, llm2, personal)
 *   ?codex=1             add one Codex login and its runtime, to show the second group
 *   ?open=1              open the runtime list (new view) / the More options block (advanced view)
 *   ?theme=<family>-<mode>
 */
import { useAccountChanges } from '../../../../app/features/fleet/shell/apply-change-panel.tsx';
import { AddRuntime } from '../../../../app/features/fleet/runtimes/add-runtime.tsx';
import type { MachineData } from '../../../../app/features/fleet/runtimes/machine-data.ts';
import { createNewFerretAccountPanel } from '../../../../app/views/account-picker-panels.tsx';
import type { LiveRuntimesClient } from '../../../../app/lib/client.ts';
import { LayeredProfileCatalogSchema, RuntimeCatalogSchema } from '../../../../contract/index.ts';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { type FunctionComponent, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimesTab } from '../../../../app/features/fleet/runtimes/runtimes-tab.tsx';
import {
  COMPONENTS,
  credential,
  machine,
  PROFILES,
  profile,
  runtime,
} from '../../../unit/app/features/fleet/account-support.ts';
import { credentialsOf } from '../../../unit/app/features/fleet/runtimes/support-b.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const count = Number(params.get('logins') ?? '4');
const withCodex = params.get('codex') === '1';
const open = params.get('open') === '1';
const view = params.get('view') ?? 'new';
const host = params.get('host') === '1';

const NAMES = ['atomi', 'llm1', 'llm2', 'personal', 'work', 'side'].slice(0, count);

const store = host ? ('host' as const) : ('ferretry' as const);
const logins = [
  ...NAMES.map(name =>
    credential({ id: name, label: name, email: `${name}@example.com`, usedBy: [name], ...(host ? { store } : {}) }),
  ),
  ...(withCodex
    ? [
        credential({
          id: 'codex-personal',
          harness: 'codex',
          harnesses: ['codex'],
          label: 'personal',
          usedBy: ['codex-personal'],
          ...(host ? { store } : {}),
        }),
      ]
    : []),
];
const loginList = credentialsOf(...logins);

// A runtime that reads a model catalog: the id the CLI is handed, and the label the catalog gives it (O12 S2).
const catalogOf = (id: string, label: string, harnessLabel: string) => ({
  modelSet: {
    source: 'model-set' as const,
    name: 'Models',
    models: [{ id, available: true }],
    declaredDefault: id,
    default: id,
  },
  models: {
    catalog: {
      id: harnessLabel.toLowerCase(),
      label: harnessLabel,
      origin: 'built-in' as const,
      customIds: false,
      docs: 'https://example.test',
    },
    choices: [{ id, label, efforts: [], available: true }],
    default: id,
  },
});

const runtimes = RuntimeCatalogSchema.parse({
  format: 'present',
  runtimes: [
    ...NAMES.map(name =>
      runtime({
        name,
        profile: 'ferretry-claude',
        credential: { id: name, store, label: name, status: 'ready' },
        ...(host ? catalogOf('claude-opus-5-5', 'Opus 5.5', 'Anthropic') : {}),
      }),
    ),
    ...(withCodex
      ? [
          runtime({
            name: 'codex-personal',
            harness: 'codex',
            profile: 'ferretry-codex',
            credential: { id: 'codex-personal', store, label: 'personal', status: 'ready' },
            ...(host ? catalogOf('gpt-6.1-sol', 'GPT-6.1 Sol', 'OpenAI') : {}),
          }),
        ]
      : []),
  ],
});

// The built-in profiles carry a plumbing name; the form says them in words ("Ferretry standard").
const profiles = LayeredProfileCatalogSchema.parse({
  ...PROFILES,
  profiles: [
    ...PROFILES.profiles,
    profile({ name: 'ferretry-claude' }),
    profile({ name: 'ferretry-codex' }),
    // The two an import makes, one per tool: the picker says them in words.
    profile({ name: 'claude-default' }),
    profile({ name: 'codex-default' }),
  ],
});

const runtimesClient = {
  call: async (route: string) => {
    if (route === 'GET /v1/runtimes') return runtimes;
    if (route === 'GET /v1/logins') return loginList;
    if (route === 'GET /v1/runtimes/profiles') return profiles;
    if (route === 'GET /v1/runtimes/components') return components;
    if (route === 'GET /v1/runtimes/machine') return machine();
    throw new Error(`no route ${route}`);
  },
  subscribe: () => () => undefined,
} as unknown as LiveRuntimesClient;

const Picker = createNewFerretAccountPanel(runtimesClient) as unknown as FunctionComponent<PanelProps>;

// With a catalog, the profile's model set names the model by the id the CLI is handed; the form says it as the catalog does.
const components = host
  ? {
      ...COMPONENTS,
      kinds: COMPONENTS.kinds.map(kind => ({
        ...kind,
        components: kind.components.map(item =>
          item.detail.kind === 'modelSets'
            ? { ...item, detail: { ...item.detail, models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } }
            : item,
        ),
      })),
    }
  : COMPONENTS;

const data: MachineData = { credentials: loginList, runtimes, profiles, components };

function Advanced() {
  const changes = useAccountChanges({ client: runtimesClient as never });
  return (
    <div className="mx-auto max-w-2xl p-4">
      <AddRuntime
        data={data}
        reload={async () => data}
        changes={changes}
        machine={null}
        machineName="studio-mac"
        online
        onFinish={() => undefined}
      />
    </div>
  );
}

function RuntimesPage() {
  return (
    <RuntimesTab
      client={runtimesClient}
      machineName="studio-mac"
      machine={machine()}
      online
      checking={false}
      onRetry={() => undefined}
    />
  );
}

function NewFerretField() {
  const [value, setValue] = useState('');
  return (
    <div className="flex flex-col gap-2" data-new-ferret-field="">
      <span id="fy-new-ferret-runtime-label" className="text-ui font-semibold text-fg">
        Runtime
      </span>
      <Picker
        {...({
          value,
          onValueChange: setValue,
          onChosen: () => undefined,
          fallbackId: 'fy-new-ferret-runtime',
          labelId: 'fy-new-ferret-runtime-label',
          fallbackPlaceholder: 'e.g. claude-default',
          noAccounts: <p data-new-ferret-no-accounts="">No runtime can run ferrets yet.</p>,
        } as unknown as PanelProps)}
      />
      <p data-chosen-runtime="" className="m-0 text-cell text-muted">
        Chosen: {value === '' ? 'nothing yet' : value}
      </p>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div data-scene-ready="" className="mx-auto max-w-2xl p-4">
      {view === 'advanced' ? <Advanced /> : view === 'runtimes' ? <RuntimesPage /> : <NewFerretField />}
    </div>,
  );

if (open)
  setTimeout(() => {
    document.querySelector<HTMLElement>('[data-add-runtime-more] summary')?.click();
  }, 400);
