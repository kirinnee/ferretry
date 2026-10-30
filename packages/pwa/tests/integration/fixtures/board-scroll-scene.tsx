/**
 * The browser entry for the Board page's SCROLL evidence: the real `BoardPage` over fake daemons, inside
 * the shell's own frame — the fixed `.kt-shell`, the page region the real `PullToPaletteRegion` hosts
 * (clipping on a phone with a tab bar, exactly as `App` composes it) and a phone's bars above and below.
 * The app bar (57px: the 44px control row, its padding and its rule) and tab bar are plain boxes of the real bars' heights: only the room they take matters here.
 *
 * Two machines: `laptop` answers with a LONG board (72 cards across four lanes) and `studio` does not,
 * so the page draws its one-line machine notice. Nothing leaves the page. Every name in it is fake.
 *
 * `?scene=phone|desktop`, `?theme=<family>-<mode>`, `?at=<lane id>` (the phone's lane), `?cols=<px>` (a desktop lane's width). Built by
 * `scripts/build-composer-integration-fixture.ts --entry` in a child process, never inside the test runner;
 * `harness/board-screenshot.ts --scroll-only` bundles the same file for the review frames.
 */

import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BoardPage } from '../../../src/features/board/board-page.tsx';
import { DaemonBoardStore } from '../../../src/lib/board-store.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { PullToPaletteRegion } from '../../../src/shell/pull-to-palette-region.tsx';
import { boardAnswer, card, COUNTS, fakePort, laneSetFor, PROJECT } from '../../unit/board-support.ts';

const LAPTOP = daemonConnection({ daemonId: 'daemon/laptop', baseUrl: 'https://laptop.example.test', deviceId: 'd-1' });
const STUDIO = daemonConnection({ daemonId: 'daemon/studio', baseUrl: 'https://studio.example.test', deviceId: 'd-2' });
const NOW = Date.parse('2026-08-01T10:04:00.000Z');
const FERRET = 'mvuc7tsf-0c3d50df';

const params = new URLSearchParams(location.search);
const phone = params.get('scene') !== 'desktop';
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const columns = Number(params.get('cols') ?? 0);
if (columns > 0) {
  const style = document.createElement('style');
  style.textContent = `.fy-board-lane { flex: 0 0 ${columns}px; min-width: ${columns}px; max-width: ${columns}px; }`;
  document.head.append(style);
}

const TITLES = [
  'Inbox v2 rich swipe actions',
  'Lane tabs stay put',
  'Surface full screen gallery',
  'Rename the drawer label',
  'Browser user agent and viewport',
  'Stop the list trapping fingers',
  'Compact the filter row',
  'Namespace billing report',
];
const LANES: readonly (readonly [string, number])[] = [
  ['todo', 36],
  ['implement', 22],
  ['review', 9],
  ['plan', 5],
];

let serial = 0;
const CARDS = LANES.flatMap(([laneId, count]) =>
  Array.from({ length: count }, (_, index) =>
    card(`F${++serial}`, {
      laneId,
      title: TITLES[index % TITLES.length],
      owner: FERRET,
      assignee: index % 3 === 0 ? 'mvudnuly-ec442385' : null,
      activity: index % 4 === 0 ? 'idle' : 'active',
      machineId: 'laptop',
    }),
  ),
);

const port = fakePort({
  board: async daemon => {
    if (daemon.daemonId === STUDIO.daemonId) throw new Error('studio.example.test did not answer');
    return boardAnswer(CARDS, { projectId: PROJECT, laneSet: laneSetFor(), counts: { ...COUNTS, active: 22 } });
  },
  projects: async () => [{ id: PROJECT, name: 'ferretry', path: null, laneSet: laneSetFor() }],
});
const store = new DaemonBoardStore(port, {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  visible: () => true,
});

const MACHINES = [
  { connection: LAPTOP, name: 'laptop' },
  { connection: STUDIO, name: 'studio' },
];

function Scene() {
  const [search, setSearch] = useState(params.get('at') === null ? '' : `at=${params.get('at')}`);
  return (
    <div className={`kt-shell flex overflow-hidden ${phone ? 'flex-col' : 'flex-row'}`}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-shell-main="">
        {phone ? (
          <header
            className="shrink-0 border-b border-border-strong bg-[var(--bar-bg)]"
            data-scene-bar="app"
            style={{ height: 57 }}
          />
        ) : null}
        <PullToPaletteRegion
          className={`relative min-h-0 min-w-0 flex-1 px-1 sm:px-3${phone ? ' overflow-clip' : ''}`}
          enabled={phone}
          onOpen={() => {
            const counted = window as unknown as { __paletteOpened?: number };
            counted.__paletteOpened = (counted.__paletteOpened ?? 0) + 1;
          }}
        >
          <div className="contents" data-page-scroll-region="">
            <BoardPage
              agenda={{ respond: async () => undefined }}
              callsigns={new Map([[FERRET, 'denisha']])}
              machines={MACHINES}
              now={NOW}
              onNavigate={() => undefined}
              onSearch={setSearch}
              origin={{ daemonId: LAPTOP.daemonId, sessionId: FERRET }}
              phone={phone}
              search={search}
              store={store}
            />
          </div>
        </PullToPaletteRegion>
        {phone ? (
          <nav
            className="shrink-0 border-t border-border-strong"
            data-safe-bottom=""
            data-scene-bar="tabs"
            style={{ height: 56 }}
          />
        ) : null}
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <StrictMode>
      <Scene />
    </StrictMode>,
  );
