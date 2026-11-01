/**
 * The lane editor, drawn by the real `LaneEditorPage` over a fake daemon (`lane-editor-screenshot.ts` bundles
 * this). `?fixture=` picks the set it serves:
 *
 * - `unconfirmed` (the default): a lane set a ferret proposed that the owner has not confirmed, so the banner shows.
 * - `pending`: the owner's confirmed lanes with a ferret's change WAITING for them — Plan/Design made automatic and
 *   Released · to test removed with its cards sent to Closed — so the waiting banner shows its warnings. Its Accept
 *   answers with the proposal live, as the daemon would.
 *
 * Nothing leaves the page.
 */

import { LANE_TEMPLATES, type LaneSet, type PendingLaneSet } from '@ferretry/protocol';
import { createRoot } from 'react-dom/client';
import { LaneEditorPage } from '../src/features/projects/lane-editor.tsx';
import { DaemonBoardStore } from '../src/lib/board-store.ts';
import { RouterProvider } from '../src/lib/router.tsx';
import { type AppStore, StoreProvider } from '../src/lib/store.tsx';
import { fakeEnvironment, fakePort, laneSetFor, laptop, PROJECT } from '../tests/unit/board-support.ts';

const DENISHA = 'mvuc7tsf-0c3d50df';
const proposed: LaneSet = { ...laneSetFor(), confirmedBy: null, proposedBy: DENISHA };

const TEMPLATE = LANE_TEMPLATES['pr-release-verify'];
const live: LaneSet = { projectId: PROJECT, version: 3, confirmedBy: 'owner', proposedBy: DENISHA, ...TEMPLATE };
const change: PendingLaneSet = {
  version: 4,
  baseVersion: 3,
  proposedBy: DENISHA,
  lanes: TEMPLATE.lanes
    .filter(lane => lane.id !== 'released')
    .map(lane =>
      lane.id === 'plan' ? { ...lane, ownerGate: false, stage: { kind: 'auto', triggers: ['work.started'] } } : lane,
    ),
  variants: Object.fromEntries(
    Object.entries(TEMPLATE.variants).map(([workflow, ids]) => [workflow, (ids ?? []).filter(id => id !== 'released')]),
  ),
  doneLane: TEMPLATE.doneLane,
  notGoodLane: TEMPLATE.notGoodLane,
  relocate: { released: 'closed' },
};
const waiting: LaneSet = { ...live, pending: change };
const { version, proposedBy, lanes, variants, doneLane, notGoodLane } = change;
const accepted: LaneSet = {
  projectId: PROJECT,
  version,
  confirmedBy: 'owner',
  proposedBy,
  lanes,
  variants,
  doneLane,
  notGoodLane,
};

const fixture = new URLSearchParams(window.location.search).get('fixture') ?? 'unconfirmed';
const served = fixture === 'pending' ? waiting : proposed;

const store = {
  board: new DaemonBoardStore(
    fakePort({
      projects: async () => [{ id: PROJECT, name: 'ferretry', path: '/work/ferretry', laneSet: served }],
      lanes: async () => ({ ok: true, value: { laneSet: accepted, agenda: 'not-needed' } }),
    }),
    fakeEnvironment(),
  ),
  attention: { respond: async () => undefined },
} as unknown as AppStore;

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="bg-bg text-fg" data-fixture="lane-editor" style={{ height: '100vh' }}>
      <StoreProvider store={store}>
        <RouterProvider>
          <LaneEditorPage callsigns={new Map([[DENISHA, 'denisha']])} connection={laptop} projectId={PROJECT} />
        </RouterProvider>
      </StoreProvider>
    </div>,
  );
