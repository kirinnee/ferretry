/** Cross-package composition proof: real Actions, Relocate, DaemonClient and Access; synthetic transport/ceremony only. */
import { ScreenHrefProvider, type DaemonReach, type PairedDaemon, type PasskeyHandler } from '@ferretry/app';
import {
  CORE,
  settingsSurface,
  DaemonClient,
  noteClientDaemon,
  deviceViewHarness,
} from '@ferretry/app/testing/settings-shell';
import type { ActionsRowOffer, ActionsRowSlotProps } from '@ferretry/core-ferrets/contract';
import { type FC, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActionsMenu } from '../../../packages/core/ferrets/app/features/header/actions-menu.tsx';
import { contributionOf } from '../../../packages/core/ferrets/app/features/header/offered-rows.ts';
import { ferretActionSections } from '../../../packages/core/ferrets/app/features/header/registry.ts';
import '../../../packages/core/ferrets/app/features/header/ferret-actions.css';
import { StepUpDialog } from '../../../packages/plugins/access/app/features/step-up/step-up-dialog.tsx';
import { stepUpAct } from '../../../packages/plugins/access/app/lib/grants.ts';
import { StepUpGate } from '../../../packages/plugins/access/app/lib/step-up-gate.ts';
import { daemonConnection } from '../../../packages/plugins/access/app/shell-grants.ts';
import { createMovedStore } from '../../../packages/plugins/relocate/app/lib/moved-store.ts';
import { createMoveMachineRowPanel } from '../../../packages/plugins/relocate/app/slots/move-machine-row.tsx';
import manifest from '../../../packages/plugins/relocate/manifest.ts';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = `studio-${params.get('scheme') ?? 'light'}`;
document.documentElement.dataset.style = params.get('style') ?? 'studio';
document.body.style.fontFamily = 'DejaVu Sans';
const SOURCE = `fy_daemon_${'A'.repeat(43)}`;
const TARGET = `fy_daemon_${'B'.repeat(43)}`;
const connection = daemonConnection({ daemonId: SOURCE, baseUrl: 'http://127.0.0.1:7480', deviceId: 'synthetic' });
let confirmed = params.get('stepup') !== '1';
let held = params.get('other') !== '1';
const counts = { held: 0, releases: 0, ceremonies: 0 };
Object.assign(window, { recoveryCounts: counts });
const gate = new StepUpGate({
  ceremony: async () => {
    counts.ceremonies++;
    confirmed = true;
  },
  describe: () => 'The passkey confirmation did not finish. Try again.',
});
const handler: PasskeyHandler = {
  need: answer =>
    (answer.body as { code?: string })?.code === 'grant_step_up_required' ? { kind: 'step-up' } : undefined,
  confirm: async (_daemon, _need, origin) =>
    await gate.require(connection, stepUpAct({ capability: 'fleet', axis: 'configure' }), origin),
  ask: async () => false,
  focus: () => undefined,
  locked: () => [],
  subscribe: () => () => undefined,
};
const surfaces = [...CORE, settingsSurface(manifest, {})];
const json = (body: unknown, status = 200) => ({ status, headers: {}, body });
const transport: ConstructorParameters<typeof DaemonClient>[0]['transport'] = {
  events: () => () => undefined,
  onReconnect: () => () => undefined,
  socket: () => {
    throw new Error('Recovery uses no socket');
  },
  request: async request => {
    if (request.path === '/v1/plugins')
      return json({ protocol: 1, plugins: surfaces.map(({ id, contract }) => ({ id, contract, on: true })) });
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    if (request.path === '/v1/relocate/moved') return json({ moved: {} });
    if (request.path === '/v1/relocate/f1/held') {
      counts.held++;
      if (!confirmed)
        return json(
          { code: 'grant_step_up_required', error: 'Confirm with your passkey on Desk, then try again.' },
          403,
        );
      if (params.get('deny') === '1')
        return json({ code: 'grant_denied', error: 'This device may not move ferrets on Desk.' }, 403);
      return json(held ? { held: true, since: '2026-11-27T00:00:00.000Z' } : { held: false });
    }
    if (request.path === '/v1/relocate/exports/release') {
      if (!confirmed)
        return json(
          { code: 'grant_step_up_required', error: 'Confirm with your passkey on Desk, then try again.' },
          403,
        );
      counts.releases++;
      held = false;
      return json({ released: true });
    }
    throw new Error(`Unexpected recovery request: ${request.method} ${request.path}`);
  },
};
const daemon = new DaemonClient({
  transport,
  surfaces,
  passkey: { daemon: { daemon: SOURCE } as PairedDaemon, handler },
  // A just-opened session is still inside the shell's navigation grace. An explicit GET must say quiet:false.
  personActing: () => false,
});
await daemon.start();
const client = daemon.forPackage('relocate');
noteClientDaemon(client, SOURCE);
const from: DaemonReach = {
  daemon: SOURCE,
  machine: 'Desk',
  client,
  online: true,
  locked: false,
  authority: () => ({ kind: 'open' }),
  authorityOf: () => ({ kind: 'open' }),
  unlock: async () => true,
  press: async act => await act(),
  hook: () => undefined,
};
// `?alone=1`: no other machine is paired at all. `?offline=1`: one is paired but unreachable.
const rows =
  params.get('alone') === '1'
    ? [from]
    : [from, { ...from, daemon: TARGET, machine: 'Laptop', online: params.get('offline') !== '1' }];
const harness = deviceViewHarness({ plugin: 'relocate', fragments: [] });
harness.setRows(rows);
const Panel = createMoveMachineRowPanel(client, createMovedStore(client)) as unknown as FC<ActionsRowSlotProps>;
function Scene() {
  const [row, setRow] = useState<ActionsRowOffer | null>(null);
  const offer = useCallback((_id: string, next: ActionsRowOffer | null) => setRow(next), []);
  return (
    <ScreenHrefProvider href={() => undefined}>
      <harness.Harness place="daemon">
        <div data-recover-actions="" style={{ padding: 16 }}>
          <ActionsMenu
            compact={innerWidth < 600}
            form={null}
            name="Zoe"
            onFormChange={() => undefined}
            sections={ferretActionSections(row === null ? [] : [contributionOf(row)], {} as never)}
          />
        </div>
        <Panel ferret="f1" name="Zoe" canControl={true} offer={offer} />
        <StepUpDialog gate={gate} machineName={() => 'Desk'} />
      </harness.Harness>
    </ScreenHrefProvider>
  );
}
const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
