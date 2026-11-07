/**
 * Board's app half, parity with today's Board surfaces (docs/design/rebuild-parity.tsv, owner `board`, kind S).
 *
 * The view modules are React and the plugin packages carry no React yet (the shell owns it), so a surface is proved two
 * ways here: the half the shell builds declares it (screens, panels, settings tab, renderers, all lazy), and the view
 * module that draws it still exports it under today's name. What a surface DRAWS is proved by the unit tests of the
 * pure models under `tests/unit/app/` and, in the browser, by the shell's own visual suite.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginClient } from '@ferretry/kernel/manifest';
import manifest from '../../manifest.ts';
import app from '../../app/index.ts';
import { parseBoardFilters, boardFiltersToSearch, NO_BOARD_FILTERS } from '../../app/lib/board-model.ts';
import { parseWorkName } from '../../app/lib/card-name.ts';
import { boardCardPath, boardPath, cardPagePath, projectLanesPath } from '../../app/lib/paths.ts';

const APP = join(import.meta.dir, '..', '..', 'app');
const source = (file: string): string => readFileSync(join(APP, file), 'utf8');
const declares = (file: string, name: string): boolean =>
  new RegExp(`(export\\s+)?(function|const)\\s+${name}\\b`, 'u').test(source(file));
const exported = (file: string, name: string): boolean =>
  new RegExp(`export\\s+(function|const)\\s+${name}\\b`, 'u').test(source(file));

const client: PluginClient = {
  call: async () => {
    throw new Error('offline');
  },
  subscribe: () => () => undefined,
} as unknown as PluginClient;

const half = app.build?.({ manifest, client });

describe('the app half the shell builds', () => {
  it('S-0341 PAGE_SLOTS Board: the board and one card are screens, every one a component', () => {
    expect(Object.keys(half?.screens ?? {}).sort()).toEqual(['board', 'card']);
    for (const screen of Object.values(half?.screens ?? {})) expect(typeof screen).toBe('function');
    expect(manifest.ui?.screens?.find(entry => entry.id === 'board')?.path).toBe('/board/:project?');
  });

  it('S-0129 LeanGroupPanel: a ferret’s cards are a panel beside the ferret', () => {
    expect(Object.keys(half?.panels ?? {}).sort()).toEqual(['card-progress', 'cards-of-ferret']);
    expect(manifest.ui?.panels?.find(entry => entry.id === 'cards-of-ferret')).toMatchObject({ slot: 'ferret.side' });
  });

  it('S-0298 feature board: the settings tab and both renderers are declared and built', () => {
    expect(Object.keys(half?.settings ?? {})).toEqual(['board']);
    expect(Object.keys(half?.renderers ?? {}).sort()).toEqual(['ask:card', 'reference:&']);
  });

  it('S-0298 feature board: the card is read-only status, so no answer surface exists', () => {
    const files = [
      'views/surfaces.tsx',
      'views/detail/board-detail.tsx',
      'views/detail/board-detail-sections.tsx',
      'views/chat-tasks.tsx',
    ];
    for (const file of files) {
      expect(source(file)).not.toMatch(/board-answers|useBoardAsks|actions\.answer|gateAttached|legacyRef/u);
    }
    expect(() => source('views/board-answers.tsx')).toThrow();
  });
});

describe('the board page and its views', () => {
  it('S-0038 BoardPage', () => expect(exported('views/board-page.tsx', 'BoardPage')).toBe(true));
  it('S-0037 BoardFilterSheet', () => expect(exported('views/board-filters.tsx', 'BoardFilterSheet')).toBe(true));
  it('S-0040 BoardSideTab', () => expect(exported('views/board-side-tab.tsx', 'BoardSideTab')).toBe(true));
  it('S-0124 KanbanView', () => expect(exported('views/board-views.tsx', 'KanbanView')).toBe(true));
  it('S-0273 TreeView', () => expect(exported('views/board-views.tsx', 'TreeView')).toBe(true));
  it('S-0088 DependenciesView', () => expect(exported('views/board-views.tsx', 'DependenciesView')).toBe(true));
  it('S-0032 ArchiveView', () => expect(exported('views/board-views.tsx', 'ArchiveView')).toBe(true));
  it('S-0266 TableView', () => expect(exported('views/board-table.tsx', 'TableView')).toBe(true));
  it('S-0263 SummaryRowView', () => expect(declares('views/board-table.tsx', 'SummaryRowView')).toBe(true));
});

describe('the card page', () => {
  it('S-0033 AskSection: the ask as the owner said it is drawn on the card, and nothing asks from it', () => {
    expect(exported('views/detail/board-detail-sections.tsx', 'AskSection')).toBe(true);
    expect(source('views/detail/board-detail-sections.tsx')).not.toMatch(/AsksList|collectAsks|respond\(/u);
  });
  it('S-0091 DetailSection', () =>
    expect(exported('views/detail/board-detail-sections.tsx', 'DetailSection')).toBe(true));
  it('S-0112 HistorySection', () =>
    expect(exported('views/detail/board-detail-sections.tsx', 'HistorySection')).toBe(true));
  it('S-0138 LinksSection', () =>
    expect(exported('views/detail/board-detail-sections.tsx', 'LinksSection')).toBe(true));
});

describe('the lane editor and the board switch', () => {
  it('S-0128 LaneEditorPage: the board app owns the editor, reached at the project’s board with ?lanes=1', () => {
    expect(exported('views/lane-editor.tsx', 'LaneEditorPage')).toBe(true);
    expect(projectLanesPath('abc')).toBe('/board/abc?lanes=1');
  });

  it('S-0041 BoardSwitchView: whether a project uses the board is Board’s route, read and put by the Projects app', () => {
    const routes = (manifest.actions?.routes ?? []).map(route => route.key);
    expect(routes).toContain('GET /v1/board/projects/:projectId/switch');
    expect(routes).toContain('PUT /v1/board/projects/:projectId/switch');
  });
});

describe('words and routes', () => {
  it('S-0333 feature tasks: a card’s name is parsed into a teammate prefix and the work', () => {
    expect(parseWorkName('[Hayden] Fix the scroller')).toEqual({ prefix: 'Hayden', task: 'Fix the scroller' });
    expect(parseWorkName('Fix the scroller')).toEqual({ prefix: null, task: 'Fix the scroller' });
    expect(parseWorkName('fix [Hayden] later').prefix).toBeNull();
    expect(exported('views/card-name.tsx', 'CardName')).toBe(true);
  });

  it('S-0369 daemonBoardPath: the board is /board', () => {
    expect(boardPath()).toBe('/board');
  });

  it('S-0367 daemonBoardCardPath: a card id after /board opens that card; /card/<id> is its own page', () => {
    expect(boardCardPath(undefined, 'F12')).toBe('/board/F12');
    expect(cardPagePath('F12')).toBe('/card/F12');
  });

  it('S-0368 daemonBoardForFerretPath: a ferret’s board is the board narrowed by ?ferret=', () => {
    const ferret = 'mvuc7tsf-0c3d50df';
    const search = boardFiltersToSearch({ ...NO_BOARD_FILTERS, ferret }).toString();
    expect(new URLSearchParams(search).get('ferret')).toBe(ferret);
    expect(parseBoardFilters(search).ferret).toBe(ferret);
  });

  it('S-0449 board-for-ferret: the narrowing the "Board for <ferret>" destination opens is the same filter', () => {
    expect(parseBoardFilters('ferret=abc').ferret).toBe('abc');
  });
});
