/**
 * The browser entry for "the Console pane the way a live capture arrives": the REAL `ConsoleSurface` over a fake pane (no daemon, no
 * network), drawn in a box the size of the workspace's side panel.
 *
 * A live tmux capture is the whole pane, and an agent that has said little leaves the rows below its last line empty, so the text
 * ends in a run of blank rows. `?blank=<n>` is how many; `?lines=<n>` is how many real lines come first.
 *
 *   ?theme=<family>-<mode>   ?w=<px> ?h=<px>   the box the Console fills (default 366 x 640)
 *   ?lines=<n>               real lines (default 14)      ?blank=<n>   trailing empty rows (default 20)
 *
 * `window.__console` is set once the first capture is on screen.
 */
import { createRoot } from 'react-dom/client';
import { ConsoleSurface } from '../../../../app/features/workspace/console-surface.tsx';
import { daemonConnection, daemonSessionScope } from '../../../../app/shell.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const number = (name: string, fallback: number): number => Number(params.get(name) ?? fallback);

const LINES = [
  '▐▛███▜▌   Claude Code v2.1.0',
  '▝▜█████▛▘  Opus 5.5 · API Usage Billing',
  '  ▘▘ ▝▝    ~/demo-app',
  '',
  '❯ Read the file /tmp/turns/turn-001.md now, then carefully follow every instruction inside it. This is your complete task for this turn.',
  '  Not logged in · Please run /login',
  '────────────────────────────────────────────────────────────────────────────────',
  '❯ Once fixed, resend your message',
  '────────────────────────────────────────────────────────────────────────────────',
  '  bypass permissions on (shift+tab to cycle)',
  'Not logged in · run /login',
];
const real = Array.from({ length: number('lines', 14) }, (_, row) => LINES[row % LINES.length] as string);
const capture = `${[...real, ...Array.from({ length: number('blank', 20) }, () => '')].join('\n')}\n`;

const daemon = daemonConnection('scene-daemon');
const scope = daemonSessionScope(daemon, 'scene-session');

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <div
      className="flex flex-col"
      data-scene-box=""
      style={{ width: `${number('w', 366)}px`, height: `${number('h', 640)}px` }}
    >
      <ConsoleSurface
        client={{ call: () => Promise.reject(new Error('the scene never calls a daemon')) }}
        connection={daemon}
        readSnapshot={async () => {
          queueMicrotask(() => {
            (window as unknown as { __console: boolean }).__console = true;
          });
          return capture;
        }}
        scope={scope}
        typeInto={async () => undefined}
      />
    </div>,
  );
}
