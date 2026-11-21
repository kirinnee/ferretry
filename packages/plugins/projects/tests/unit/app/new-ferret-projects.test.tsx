import { afterEach, describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import { ProjectInfoSchema } from '../../../contract/index.ts';
import { createNewFerretProjectsPanel } from '../../../app/views/new-ferret-projects.tsx';
import { startFerretHref } from '../../../app/lib/start-href.ts';
import { projectLine } from '../../../app/lib/project-line.ts';
import { clickEvent, PROJECT, scripted } from './support/client.ts';

const SECOND = ProjectInfoSchema.parse({
  id: '33333333-3333-4333-8333-333333333333',
  name: 'website',
  path: '/work/website',
  source: 'clone',
  createdAt: '2026-08-02T10:00:00.000Z',
  repos: [{ path: '.', remote: 'https://github.com/acme/website', provider: 'github' }],
});

let open: Mounted | null = null;
afterEach(async () => {
  await open?.unmount();
  open = null;
});

const draw = async (projects: unknown, value = '', onPick: (folder: string) => void = () => undefined) => {
  // A slot panel is handed the slot's props (`value`, `onPick`), which PanelProps does not name.
  const Panel = createNewFerretProjectsPanel(scripted({ 'GET /v1/projects': projects })) as (props: {
    readonly value: string;
    readonly onPick: (folder: string) => void;
  }) => ReactNode;
  open = await mount(<Panel onPick={onPick} value={value} />);
  return open;
};

const rows = (view: Mounted): HTMLButtonElement[] => [
  ...view.container.querySelectorAll<HTMLButtonElement>('[data-new-ferret-project-row]'),
];

describe('the New ferret projects panel', () => {
  it('lists the registered projects and fills the folder field with the one picked', async () => {
    const picked: string[] = [];
    const view = await draw([PROJECT, SECOND], '', folder => picked.push(folder));
    await settleUntil(() => rows(view).length === 2, 'the project rows', interact);

    expect(rows(view).map(row => row.textContent)).toEqual(['ferretry/work/ferretry', 'websiteacme/website']);
    await interact(() => rows(view)[1]?.dispatchEvent(clickEvent()));
    expect(picked).toEqual(['/work/website']);
  });

  it('marks the row whose folder is in the field, and only that one', async () => {
    const view = await draw([PROJECT, SECOND], '/work/website');
    await settleUntil(() => rows(view).length === 2, 'the project rows', interact);
    expect(rows(view).map(row => row.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  it('draws nothing with no projects, so the Folder box is never pushed down for nothing', async () => {
    const view = await draw([]);
    await interact(async () => await new Promise(resolve => setTimeout(resolve, 20)));
    expect(view.container.querySelector('[data-new-ferret-projects]')).toBeNull();
  });

  it('shows five rows and the rest behind More…', async () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      ...PROJECT,
      id: `00000000-0000-4000-8000-00000000000${index}`,
      name: `p${index}`,
      path: `/work/p${index}`,
    }));
    const view = await draw(many);
    await settleUntil(() => rows(view).length === 5, 'five rows', interact);
    const more = must(
      [...view.container.querySelectorAll('button')].find(button => (button.textContent ?? '').startsWith('More…')),
      'More…',
    );
    await interact(() => more.dispatchEvent(clickEvent()));
    expect(rows(view)).toHaveLength(7);
  });
});

describe('startFerretHref', () => {
  it('opens New ferret on this daemon with the folder encoded', () => {
    expect(startFerretHref('workstation', '/work/my project&x')).toBe(
      '/d/workstation/new?folder=%2Fwork%2Fmy%20project%26x',
    );
  });
});

describe('projectLine', () => {
  it('names the repository, else the folder', () => {
    expect(projectLine(PROJECT)).toBe('/work/ferretry');
    expect(projectLine(SECOND)).toBe('acme/website');
    const two = { ...SECOND, repos: [...(SECOND.repos ?? []), { path: 'api', remote: 'https://github.com/acme/api' }] };
    expect(projectLine(two)).toBe('acme/website + 1 more');
  });
});
