/**
 * The lane editor, drawn by the real `LaneEditorPage` over a fake daemon (`lane-editor-screenshot.ts` bundles
 * this). `?fixture=` picks the set it serves:
 *
 * - `unconfirmed` (the default): a lane set a ferret proposed that the owner has not confirmed, so the banner shows.
 * - `rewired`: a waiting change that rewires Plan/Design's "OK to build" to close the card (review probe P8).
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

/** P8: Plan/Design's "OK to build" rewired to close the card, and Merged moved ahead of In progress. */
const rewired: LaneSet = {
  ...live,
  pending: {
    version: 4,
    baseVersion: 3,
    proposedBy: 'mvuc7tsf-0c3d50df',
    proposerSession: 'mvuc7tsf-0c3d50df',
    lanes: [
      {
        id: 'todo',
        name: 'Todo',
        category: 'backlog',
        staleAfter: '3d',
        emphasis: 'progress',
        stage: { kind: 'auto', triggers: [] },
      },
      {
        id: 'plan',
        name: 'Plan/Design',
        category: 'active',
        enterOn: ['work.started'],
        ownerGate: true,
        staleAfter: '2h',
        emphasis: 'action',
        stage: { kind: 'gate', options: [{ id: 'ok', label: 'OK to build', outcome: { kind: 'close' } }] },
      },
      {
        id: 'merged',
        name: 'Merged',
        category: 'shipped',
        enterOn: ['pr.merged'],
        staleAfter: '3d',
        emphasis: 'info',
        stage: { kind: 'auto', triggers: ['pr.merged'] },
      },
      {
        id: 'implement',
        name: 'In progress',
        category: 'active',
        enterOn: ['work.started', 'pr.opened', 'pr.ready'],
        staleAfter: '4h',
        emphasis: 'progress',
        stage: { kind: 'auto', triggers: ['work.started', 'pr.opened', 'pr.ready'] },
      },
      {
        id: 'released',
        name: 'Released · to test',
        category: 'verify',
        enterOn: ['release.published'],
        ownerGate: true,
        emphasis: 'action',
        stage: {
          kind: 'gate',
          options: [
            { id: 'done', label: 'Done', outcome: { kind: 'close' } },
            { id: 'not-good', label: 'Not good', outcome: { kind: 'reopen-with-agenda' } },
          ],
        },
      },
      {
        id: 'closed',
        name: 'Closed',
        category: 'closed',
        ownerGate: true,
        emphasis: 'info',
        stage: { kind: 'auto', triggers: [] },
      },
    ],
    variants: {
      quick: ['todo', 'merged', 'implement', 'released', 'closed'],
      'design-first': ['todo', 'plan', 'merged', 'implement', 'released', 'closed'],
      'research-first': ['todo', 'plan', 'merged', 'implement', 'released', 'closed'],
      investigate: ['todo', 'merged', 'implement', 'released', 'closed'],
    },
    doneLane: 'closed',
    notGoodLane: 'implement',
    relocate: {},
  } as PendingLaneSet,
};

const fixture = new URLSearchParams(window.location.search).get('fixture') ?? 'unconfirmed';
const SERVED: Readonly<Record<string, LaneSet>> = { pending: waiting, rewired };
const served = SERVED[fixture] ?? proposed;

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
