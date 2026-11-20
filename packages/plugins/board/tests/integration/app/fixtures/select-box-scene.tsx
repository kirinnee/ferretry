/**
 * The browser entry for "the board's choices from a list are the app's own SelectBox" (r11 S3c), over fake data:
 *
 *   ?scene=filters   the REAL filter bar (a bottom sheet of the same fields under 768px), writes recorded on `window.__filters`
 *   ?scene=lanes     the REAL lanes page (category and outcome pickers; a lane's delete prompt), the daemon's lanes route
 *                    faked: every request it is sent is recorded on `window.__lanes` and answered with the set saved
 *   &theme=<family>-<mode>
 */

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type BoardProjectId, boardOk, type LaneSetActionRequestInput } from '../../../../contract/index.ts';
import { type BoardFilters, NO_BOARD_FILTERS } from '../../../../app/lib/board-model.ts';
import { DaemonBoardStore } from '../../../../app/lib/board-store.ts';
import { THIS_MACHINE } from '../../../../app/lib/machine.ts';
import { BoardFilterBar, BoardFilterSheet } from '../../../../app/views/board-filters.tsx';
import { LaneEditorPage } from '../../../../app/views/lane-editor.tsx';
import { fakeEnvironment, fakePort, laneSetFor, PROJECT } from '../../../unit/app/board-support.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('scene') ?? 'filters';
const phone = window.innerWidth < 768;

const seen = window as unknown as { __filters: BoardFilters | null };
seen.__filters = null;

/** What the fake lanes route was sent, in order (the same body the daemon would receive). */
const sent = window as unknown as { __lanes: { projectId: string; request: LaneSetActionRequestInput }[] };
sent.__lanes = [];

const choices = {
  projects: [
    { id: PROJECT, name: 'ferretry' },
    { id: 'p-other' as BoardProjectId, name: 'docs site' },
  ],
  machines: [],
  ferrets: [
    { id: 'zoe', name: 'Zoe' },
    { id: 'kai', name: 'Kai' },
  ],
  // More than seven, so the list has a search field.
  lanes: ['Todo', 'Plan/Design', 'Implement', 'Review/CI', 'Merged', 'Released', 'To test', 'Closed', 'Parked'],
} as const;

function Filters() {
  const [filters, setFilters] = useState<BoardFilters>(NO_BOARD_FILTERS);
  const change = (next: BoardFilters): void => {
    seen.__filters = next;
    setFilters(next);
  };
  const props = { choices, filters, onChange: change };
  return <div style={{ padding: 12 }}>{phone ? <BoardFilterSheet {...props} /> : <BoardFilterBar {...props} />}</div>;
}

const store = new DaemonBoardStore(
  fakePort({
    projects: async () => [{ id: PROJECT, name: 'ferretry', path: '/work/ferretry', laneSet: laneSetFor() }],
    lanes: async (_daemon, projectId, request) => {
      sent.__lanes.push({ projectId, request });
      return boardOk({ laneSet: { ...laneSetFor(), version: 2 }, ask: 'not-needed' });
    },
  }),
  fakeEnvironment(),
);

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    scene === 'lanes' ? (
      <LaneEditorPage
        callsigns={new Map()}
        connection={THIS_MACHINE}
        onBack={() => undefined}
        projectId={PROJECT}
        store={store}
      />
    ) : (
      <Filters />
    ),
  );
