/**
 * The lane editor over a confirmed lane set, so every lane row shows its stage switch: gate lanes with their
 * options, automatic lanes with their triggers (`lane-editor-stages-screenshot.ts` bundles this). Nothing leaves
 * the page.
 */

import { createRoot } from 'react-dom/client';
import { LaneEditorPage } from '../src/features/projects/lane-editor.tsx';
import { DaemonBoardStore } from '../src/lib/board-store.ts';
import { RouterProvider } from '../src/lib/router.tsx';
import { type AppStore, StoreProvider } from '../src/lib/store.tsx';
import { fakeEnvironment, fakePort, laneSetFor, laptop, PROJECT } from '../tests/unit/board-support.ts';

const store = {
  board: new DaemonBoardStore(
    fakePort({
      projects: async () => [{ id: PROJECT, name: 'ferretry', path: '/work/ferretry', laneSet: laneSetFor() }],
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
          <LaneEditorPage callsigns={new Map()} connection={laptop} projectId={PROJECT} />
        </RouterProvider>
      </StoreProvider>
    </div>,
  );
