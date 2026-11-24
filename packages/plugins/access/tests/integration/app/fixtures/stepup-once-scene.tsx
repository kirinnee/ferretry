/**
 * The browser entry for "Confirm it's you" over fake data (O12 S4): the REAL `StepUpDialog` and `StepUpGate`, with no
 * daemon, on a machine whose step-up window is the default 15 minutes.
 *
 *   ?theme=<family>-<mode>&state=import|change
 *
 *  - `import`: the daemon refused an import for want of its own `loosen-config` passkey, so the prompt says it confirms
 *    that one change (the next import asks again) and never promises the 15-minute window;
 *  - `change`: an ordinary settings change that names no act, so the prompt says the machine's window.
 */

import { STEP_UP_ACTS } from '@ferretry/core-gate/contract';
import { createRoot } from 'react-dom/client';
import { StepUpDialog } from '../../../../app/features/step-up/step-up-dialog.tsx';
import { stepUpAct } from '../../../../app/lib/grants.ts';
import { stepUpStaysSentence } from '../../../../app/lib/security-settings-client.ts';
import { StepUpGate } from '../../../../app/lib/step-up-gate.ts';
import { daemonConnection } from '../../../../app/shell-grants.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const importing = params.get('state') !== 'change';

const machine = daemonConnection({
  daemonId: 'fake-daemon',
  baseUrl: 'http://127.0.0.1:7617',
  deviceId: 'fake-device',
});

const gate = new StepUpGate({
  ceremony: async () => undefined,
  describe: () => 'The passkey confirmation did not finish. Try again.',
  scope: async () => stepUpStaysSentence(15),
});
if (importing)
  void gate.require(
    machine,
    stepUpAct({ capability: 'fleet', axis: 'configure', act: STEP_UP_ACTS.loosenConfig }),
    'explicit',
    STEP_UP_ACTS.loosenConfig,
  );
else void gate.require(machine, stepUpAct({ capability: 'fleet', axis: 'configure' }));

const root = document.getElementById('root');
if (root === null) throw new Error('the scene page has no #root');
createRoot(root).render(<StepUpDialog gate={gate} machineName={() => 'Fake Box'} />);
