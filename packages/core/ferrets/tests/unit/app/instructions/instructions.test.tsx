/**
 * S-0075 the context rail's Instructions list (v4 `ContextDocsPanel`): the instruction files in the ferret's folder, with search
 * and chips; a row opens the file in Files. Over a scripted daemon listing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PanelProps } from '@ferretry/kernel/manifest';
import type { FunctionComponent } from 'react';
import { createFilesPanel } from '../../../../app/views/files.tsx';
import { createInstructionsPanel } from '../../../../app/views/instructions.tsx';
import { resetFsProbes } from '../../../../app/features/files/files-api.ts';
import { resetFilesTabStates } from '../../../../app/features/files/files-tab-model.ts';
import {
  docChips,
  docSize,
  instructionDocs,
  visibleDocs,
} from '../../../../app/features/instructions/instructions-model.ts';
import type { LiveFerretsClient } from '../../../../app/lib/client.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

const entry = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: 'file', size: 1_500, ...extra });

const LISTING = {
  root: '/work/ferretry',
  path: '',
  entries: [
    entry('README.md'),
    entry('AGENTS.md', { size: 400 }),
    entry('CLAUDE.md', { size: 12_800 }),
    entry('GEMINI.md'),
    entry('CLAUDE.local.md', { denied: true }),
    { name: 'AGENTS.override.md', type: 'dir' },
    entry('src', { type: 'dir' }),
  ],
};

let mounted: Mounted | undefined;
beforeEach(() => {
  resetFsProbes();
  resetFilesTabStates();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const daemon = (answers: { listing?: unknown | Error } = {}, asked: string[] = []): LiveFerretsClient =>
  ({
    call: async (route: string, init?: { query?: Record<string, string> }) => {
      asked.push(`${route}${init?.query?.path === undefined ? '' : `?path=${init.query.path}`}`);
      if (route === 'GET /v1/ferrets/:ferretId/fs') {
        const listing = answers.listing === undefined ? LISTING : answers.listing;
        if (listing instanceof Error) throw listing;
        return listing;
      }
      if (route === 'GET /v1/ferrets/:ferretId/fs/file')
        return { path: init?.query?.path ?? '', size: 9, content: `# ${init?.query?.path ?? ''}` };
      if (route === 'GET /v1/ferrets/:ferretId/fs/changes') return { repo: false, changes: [] };
      throw new Error(`no route ${route}`);
    },
  }) as unknown as LiveFerretsClient;

const names = (root: ParentNode): (string | null)[] =>
  [...root.querySelectorAll('[data-context-doc]')].map(node => node.getAttribute('data-context-doc'));

describe('S-0075 the instruction files of a folder', () => {
  it('S-0075 keeps only the known instruction files that are served, in the agent order, with their sizes', () => {
    const docs = instructionDocs(LISTING.entries as never);
    // README is no instruction file; CLAUDE.local.md is denied; AGENTS.override.md is a folder, not a file.
    expect(docs.map(doc => doc.path)).toEqual(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']);
    expect(docSize(docs[0] as never)).toBe('13 KB');
    expect(docs.map(doc => doc.name).filter(name => name.startsWith('CLAUDE.'))).toEqual(['CLAUDE.md']);
  });

  it('S-0075 chips count what the search leaves, and Claude vs Generic split by the file name', () => {
    const docs = instructionDocs(LISTING.entries as never);
    expect(docChips(docs, '').map(chip => [chip.key, chip.count])).toEqual([
      ['all', 3],
      ['claude', 1],
      ['generic', 2],
    ]);
    expect(visibleDocs(docs, 'agents', 'all').map(doc => doc.name)).toEqual(['AGENTS.md']);
    expect(visibleDocs(docs, '', 'generic').map(doc => doc.name)).toEqual(['AGENTS.md', 'GEMINI.md']);
  });
});

describe('S-0075 the Instructions panel', () => {
  it('S-0075 lists the folder’s instruction files, narrows by search and chip, and reads only the folder’s root', async () => {
    const asked: string[] = [];
    const Panel = createInstructionsPanel(daemon({}, asked)) as FunctionComponent<PanelProps>;
    mounted = await mount(<Panel subject="f1" />);
    await settle();
    const root = mounted.container;
    expect(names(root)).toEqual(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']);
    expect(asked).toEqual(['GET /v1/ferrets/:ferretId/fs']);
    expect(root.querySelector('[data-context-doc="CLAUDE.md"]')?.textContent).toContain('13 KB');
    expect(root.querySelector('[data-context-doc="CLAUDE.md"]')?.textContent).toContain('opens in a Files tab');
    expect(root.querySelector('[data-context-doc="CLAUDE.md"]')?.getAttribute('aria-label')).toBe(
      'Open CLAUDE.md in a Files tab',
    );
    // A chip narrows to one family.
    const chip = [...root.querySelectorAll<HTMLElement>('button')].find(button =>
      button.textContent?.startsWith('Claude'),
    );
    await interact(() => must(chip, 'the Claude chip').click());
    await settle();
    expect(names(root)).toEqual(['CLAUDE.md']);
  });

  it('S-0075 says so when the folder has none, and why when the read failed', async () => {
    const Empty = createInstructionsPanel(
      daemon({ listing: { root: '/w', path: '', entries: [entry('README.md')] } }),
    ) as FunctionComponent<PanelProps>;
    mounted = await mount(<Empty subject="f1" />);
    await settle();
    expect(mounted.container.textContent).toContain('No instruction files in this folder.');
    await mounted.unmount();

    const Failing = createInstructionsPanel(
      daemon({ listing: new Error('the daemon is away') }),
    ) as FunctionComponent<PanelProps>;
    mounted = await mount(<Failing subject="f1" />);
    await settle();
    expect(mounted.container.textContent).toContain('list this folder’s instructions');
    expect(mounted.container.textContent).toContain('the daemon is away');
  });

  it('S-0075 asks for a ferret when none is named', async () => {
    const Panel = createInstructionsPanel(daemon()) as FunctionComponent<PanelProps>;
    mounted = await mount(<Panel />);
    expect(mounted.container.textContent).toContain('Pick a ferret to see its instructions.');
  });

  it('S-0075 a row opens that file in the ferret’s Files panel', async () => {
    const client = daemon();
    const Instructions = createInstructionsPanel(client) as FunctionComponent<PanelProps>;
    const Files = createFilesPanel(client) as FunctionComponent<PanelProps>;
    mounted = await mount(
      <>
        <Instructions subject="f1" />
        <Files subject="f1" />
      </>,
    );
    await settle();
    await interact(() =>
      must(
        mounted?.container.querySelector<HTMLElement>('[data-context-doc="AGENTS.md"]'),
        'the AGENTS.md row',
      ).click(),
    );
    await settle();
    // Files drew the file the row named, in its own tab.
    expect(mounted.container.textContent).toContain('# AGENTS.md');
  });
});
