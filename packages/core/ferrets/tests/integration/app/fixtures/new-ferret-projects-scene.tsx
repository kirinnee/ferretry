/**
 * Browser entry for r11 S8 on the FERRETS side: the REAL `NewFerretPage` over a daemon that answers from memory, with the
 * `ferrets.new-ferret-project` slot filled by a stand-in for Projects' panel (a plugin's panel is proved in Projects' own
 * suite; here the page's own slot ORDER, `?folder=` prefill and start are what is under test). Every call lands on
 * `window.__calls`. No network.
 *
 *   ?projects=<n>    how many projects the fake registers (default 2; project 2's folder ends in a space)
 *   ?folder=<path>   what a project's "Start a ferret here" appends
 *   ?theme=<family>-<mode>
 */
import { NEW_FERRET_PROJECT_SLOT, type NewFerretProjectSlotProps } from '@ferretry/core-ferrets/contract';
import { WithSlotPanels } from '@ferretry/app/testing/settings-shell';
import { type ReactNode, useEffect, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { FerretsClient } from '../../../../app/lib/client.ts';
import { NewFerretPage } from '../../../../app/features/new-ferret/new-ferret-page.tsx';
import { initialFolderOf } from '../../../../app/views/new-ferret.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const count = Number(params.get('projects') ?? '2');

const FOLDERS = Array.from({ length: count }, (_, index) => `/fake/p${index + 1}${index === 1 ? ' ' : ''}`);

interface Recorded {
  route: string;
  headers: Record<string, string> | undefined;
  body: unknown;
}
const calls: Recorded[] = [];
const win = window as unknown as { __calls: Recorded[]; __firstFolder?: string; __navigated: string[] };
win.__calls = calls;
win.__navigated = [];

const client: FerretsClient = {
  call: async <Answer,>(
    route: string,
    init?: { headers?: Record<string, string>; body?: unknown },
  ): Promise<Answer> => {
    calls.push({ route, headers: init?.headers, body: init?.body });
    if (route === 'GET /v1/ferrets') return [] as Answer;
    if (route === 'POST /v1/ferrets') return { id: 'new-ferret' } as Answer;
    throw new Error(`no route ${route}`);
  },
} as FerretsClient;

/**
 * Stands in for Projects' panel: a box that carries the label id the page hands it and shows the folder the page holds,
 * and a row per project that proposes its folder through the slot's `onPick`.
 */
const projectsPanel = (props: Record<string, unknown>): ReactNode => {
  const slot = props as unknown as NewFerretProjectSlotProps;
  // The page draws nothing of the form until the field says its read is over; a stand-in has nothing to read.
  useEffect(() => slot.onSettled?.(), [slot.onSettled]);
  return (
    <section data-new-ferret-projects="">
      <input className="kt-input w-full font-mono" id={slot.id} readOnly value={slot.value} />
      <h3>Your projects</h3>
      <ul>
        {FOLDERS.map((folder, index) => (
          <li key={folder}>
            <button
              aria-pressed={slot.value === folder}
              className="min-h-[44px]"
              data-new-ferret-project-row={`p${index + 1}`}
              onClick={() => slot.onPick(folder)}
              type="button"
            >
              project-{index + 1}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
};

/** Records what the Folder box held when the page FIRST committed: the prefill must be there on first render. */
function FirstPaint({ children }: { readonly children: ReactNode }) {
  useLayoutEffect(() => {
    win.__firstFolder = document.querySelector<HTMLInputElement>('#fy-new-ferret-folder')?.value;
  }, []);
  return children;
}

const initialFolder = initialFolderOf(window.location.search);
const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div data-scene-ready="">
      <WithSlotPanels
        slots={{ [NEW_FERRET_PROJECT_SLOT]: [{ plugin: 'projects', id: 'new-ferret-projects', view: projectsPanel }] }}
      >
        <FirstPaint>
          <NewFerretPage
            AccountSlot={({ fallback }) => fallback}
            client={client}
            daemon="fake"
            onNavigate={path => win.__navigated.push(path)}
            {...(initialFolder === undefined ? {} : { initialFolder })}
          />
        </FirstPaint>
      </WithSlotPanels>
    </div>,
  );
