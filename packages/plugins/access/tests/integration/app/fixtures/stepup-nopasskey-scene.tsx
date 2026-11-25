/**
 * The browser entry for "Confirm it's you" for a device with NO passkey, over fake data: the REAL `StepUpDialog` and
 * `StepUpGate`, with no daemon. The device, machine and command are fixed fakes.
 *
 *   ?theme=<family>-<mode>&state=window|no-window|passkey[&demand=<capability>:<axis>[:<act>]]
 *
 *  - `window`: a passkey window is open, so the prompt offers Add a passkey in place;
 *  - `no-window`: no window, so it says the device has no passkey yet and prints the owner's command (`fy5` here, the
 *    program the fake daemon reports);
 *  - `passkey`: the device already has one, so the prompt is the plain "Confirm with your passkey to <act>" (the act is drawn only here).
 *
 * `demand` is the refusal's own demand (the default is a plain terminal use); the words come from the REAL `stepUpAct`.
 */

import { createRoot } from 'react-dom/client';
import { StepUpDialog } from '../../../../app/features/step-up/step-up-dialog.tsx';
import { stepUpAct } from '../../../../app/lib/grants.ts';
import { StepUpGate } from '../../../../app/lib/step-up-gate.ts';
import type { StepUpDemand } from '@ferretry/core-gate/contract';
import { daemonConnection } from '../../../../app/shell-grants.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const state = params.get('state');
const windowOpen = state !== 'no-window';
const hasPasskey = state === 'passkey';

const machine = daemonConnection({
  daemonId: 'fake-daemon',
  baseUrl: 'http://127.0.0.1:7617',
  deviceId: 'fake-device',
});

const gate = new StepUpGate({
  ceremony: async () => undefined,
  describe: () => 'The passkey confirmation did not finish. Try again.',
  firstPasskey: async () => windowOpen && !hasPasskey,
  ownerCommand: async () => (windowOpen || hasPasskey ? undefined : "fy5 passkey window 'Fake Browser'"),
});
const [capability = 'terminal', axis = 'use', act] = (params.get('demand') ?? 'terminal:use').split(':');
void gate.require(machine, stepUpAct({ capability, axis, ...(act === undefined ? {} : { act }) } as StepUpDemand));

const root = document.getElementById('root');
if (root === null) throw new Error('the scene page has no #root');
createRoot(root).render(<StepUpDialog gate={gate} machineName={() => 'fake-machine'} />);
