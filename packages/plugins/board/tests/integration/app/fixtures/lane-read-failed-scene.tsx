/**
 * The browser entry for "the lanes page when the machine's projects cannot be read": the REAL `LaneEditorPage` over a
 * fake machine that refuses the project read until the person presses Try again (a read marked `quiet: false`).
 *
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import { DaemonBoardStore } from '../../../../app/lib/board-store.ts';
import { THIS_MACHINE } from '../../../../app/lib/machine.ts';
import { LaneEditorPage } from '../../../../app/views/lane-editor.tsx';
import { fakeEnvironment, fakePort, laneSetFor, PROJECT } from '../../../unit/app/board-support.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const seen = window as unknown as { __projectReads: (boolean | null)[] };
seen.__projectReads = [];

const store = new DaemonBoardStore(
  fakePort({
    projects: async (_daemon, press) => {
      const pressed = press?.quiet === false;
      seen.__projectReads.push(pressed ? false : null);
      if (!pressed) throw new Error('could not reach this machine');
      return [{ id: PROJECT, name: 'ferretry', path: '/work/ferretry', laneSet: laneSetFor() }];
    },
  }),
  fakeEnvironment(),
);

createRoot(document.getElementById('root') as HTMLElement).render(
  <LaneEditorPage
    callsigns={new Map()}
    connection={THIS_MACHINE}
    onBack={() => undefined}
    projectId={PROJECT}
    store={store}
  />,
);
