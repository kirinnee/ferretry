import { type FunctionComponent, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { PanelProps } from '@ferretry/kernel/manifest';
import type { NewFerretAccountSlotProps } from '@ferretry/core-ferrets/contract';
import { NewFerretPage } from '../../../../../../core/ferrets/app/features/new-ferret/new-ferret-page.tsx';
import { AddRuntime } from '../../../../app/features/fleet/runtimes/add-runtime.tsx';
import { readMachineData, type MachineData } from '../../../../app/features/fleet/runtimes/machine-data.ts';
import { useAccountChanges } from '../../../../app/features/fleet/shell/apply-change-panel.tsx';
import { createNewFerretAccountPanel } from '../../../../app/views/account-picker-panels.tsx';
import type { LiveRuntimesClient } from '../../../../app/lib/client.ts';
import { MachineViewSchema } from '../../../../contract/index.ts';

const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get('theme') ?? 'studio-light';
const scenario = query.get('case') ?? 'manual';
const mode = query.get('mode') ?? 'new';
const client = {
  subscribe: () => () => undefined,
  call: async (route: string, init?: unknown) => {
    const response = await fetch(`/rpc?case=${encodeURIComponent(scenario)}&mode=${mode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ route, init }),
    });
    const value = await response.json();
    if (!value.ok)
      throw Object.assign(new Error(value.message), { status: value.status, code: value.code, body: value.body });
    return value.answer;
  },
} as unknown as LiveRuntimesClient;
const machine = MachineViewSchema.parse(await client.call('GET /v1/runtimes/machine'));
const initial = await readMachineData(client);
const Picker = createNewFerretAccountPanel(client) as FunctionComponent<PanelProps>;
const AccountSlot = ({ slot }: { slot: NewFerretAccountSlotProps; fallback: ReactNode }) => (
  <Picker {...(slot as unknown as PanelProps)} />
);

function Advanced() {
  const [data, setData] = useState<MachineData>(initial);
  const changes = useAccountChanges({ client });
  return (
    <div className="mx-auto max-w-2xl p-4">
      <AddRuntime
        data={data}
        changes={changes}
        machine={machine}
        machineName="test-machine"
        online
        onFinish={() => undefined}
        reload={async () => {
          const next = await readMachineData(client);
          setData(next);
          return next;
        }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  mode === 'add' || mode === 'pin' ? (
    <Advanced />
  ) : (
    <NewFerretPage
      daemon="test-machine"
      client={client as never}
      onNavigate={() => undefined}
      initialAgent="opencode-plain"
      initialFolder="/work/project"
      AccountSlot={AccountSlot}
    />
  ),
);
