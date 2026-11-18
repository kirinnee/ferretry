/**
 * The browser entry for "Confirm it's you" for a device with NO passkey, over fake data: the REAL `StepUpDialog` and
 * `StepUpGate`, with no daemon. The device, machine and command are fixed fakes.
 *
 *   ?theme=<family>-<mode>&state=window|no-window
 *
 *  - `window`: a passkey window is open, so the prompt offers Add a passkey in place;
 *  - `no-window`: no window, so it says the device has no passkey yet and prints the owner's command (`fy5` here, the
 *    program the fake daemon reports).
 */

import { createRoot } from 'react-dom/client';
import { StepUpDialog } from '../../../../app/features/step-up/step-up-dialog.tsx';
import { StepUpGate } from '../../../../app/lib/step-up-gate.ts';
import { daemonConnection } from '../../../../app/shell-grants.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const windowOpen = params.get('state') !== 'no-window';

const machine = daemonConnection({
  daemonId: 'fake-daemon',
  baseUrl: 'http://127.0.0.1:7617',
  deviceId: 'fake-device',
});

const gate = new StepUpGate({
  ceremony: async () => undefined,
  describe: () => 'The passkey confirmation did not finish. Try again.',
  firstPasskey: async () => windowOpen,
  ownerCommand: async () => (windowOpen ? undefined : "fy5 passkey window 'Fake Browser'"),
});
void gate.require(machine, 'open a terminal');

const root = document.getElementById('root');
if (root === null) throw new Error('the scene page has no #root');
createRoot(root).render(<StepUpDialog gate={gate} machineName={() => 'fake-machine'} />);
