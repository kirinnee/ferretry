/**
 * Browser entry for O8-9, "a ready login is a runtime": the REAL runtime picker New ferret draws (Runtimes' panel, in the
 * field New ferret gives it) over a daemon that answers from memory, and the REAL Advanced "Add a runtime" form. Fake data, no network.
 *
 *   ?view=new|advanced   the New ferret runtime field (default) or the Advanced form
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
import { credential, PROFILES, profile, runtime } from '../../../unit/app/features/fleet/account-support.ts';
import { credentialsOf } from '../../../unit/app/features/fleet/runtimes/support-b.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const count = Number(params.get('logins') ?? '4');
const withCodex = params.get('codex') === '1';
const open = params.get('open') === '1';
const view = params.get('view') ?? 'new';

const NAMES = ['atomi', 'llm1', 'llm2', 'personal', 'work', 'side'].slice(0, count);

const logins = [
  ...NAMES.map(name => credential({ id: name, label: name, email: `${name}@example.com`, usedBy: [name] })),
  ...(withCodex
    ? [
        credential({
          id: 'codex-personal',
          harness: 'codex',
          harnesses: ['codex'],
          label: 'personal',
          usedBy: ['codex-personal'],
        }),
      ]
    : []),
];
const loginList = credentialsOf(...logins);

const runtimes = RuntimeCatalogSchema.parse({
  format: 'present',
  runtimes: [
    ...NAMES.map(name =>
      runtime({
        name,
        profile: 'ferretry-claude',
        credential: { id: name, store: 'ferretry', label: name, status: 'ready' },
      }),
    ),
    ...(withCodex
      ? [
          runtime({
            name: 'codex-personal',
            harness: 'codex',
            profile: 'ferretry-codex',
            credential: { id: 'codex-personal', store: 'ferretry', label: 'personal', status: 'ready' },
          }),
        ]
      : []),
  ],
});

// The built-in profiles carry a plumbing name; the form says them in words ("Ferretry standard").
const profiles = LayeredProfileCatalogSchema.parse({
  ...PROFILES,
  profiles: [...PROFILES.profiles, profile({ name: 'ferretry-claude' }), profile({ name: 'ferretry-codex' })],
});

const runtimesClient = {
  call: async (route: string) => {
    if (route === 'GET /v1/runtimes') return runtimes;
    if (route === 'GET /v1/logins') return loginList;
    throw new Error(`no route ${route}`);
  },
  subscribe: () => () => undefined,
} as unknown as LiveRuntimesClient;

const Picker = createNewFerretAccountPanel(runtimesClient) as unknown as FunctionComponent<PanelProps>;

const data: MachineData = { credentials: loginList, runtimes, profiles, components: null };

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
      {view === 'advanced' ? <Advanced /> : <NewFerretField />}
    </div>,
  );

if (open)
  setTimeout(() => {
    document.querySelector<HTMLElement>('[data-add-runtime-more] summary')?.click();
  }, 400);
