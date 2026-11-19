import { describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, pressKey, settleUntil } from '@ferretry/app/testing';
import { FolderPicker } from '../../../app/features/folder-explorer/folder-picker.tsx';
import { explorerViewPreference } from '../../../app/features/folder-explorer/explorer-view-preference.ts';
import { type Call, clickEvent, refusal, scripted, typeInto } from './support/client.ts';

const LIST = 'GET /v1/projects/folders';
const MAKE = 'POST /v1/projects/folders';
const at = '2026-08-01T10:00:00.000Z';

const entry = (name: string, kind: 'folder' | 'file' = 'folder', isRepo = false) => ({
  name,
  kind,
  isRepo,
  hidden: name.startsWith('.'),
  modifiedAt: at,
});

/** A fake home: ~ holds work (with a repo) and notes.md; ~/work holds ferretry (a repo) and scratch. */
const TREE: Record<string, readonly ReturnType<typeof entry>[]> = {
  '/home/k': [entry('work'), entry('notes.md', 'file'), entry('.config')],
  '/home/k/work': [entry('ferretry', 'folder', true), entry('scratch')],
  '/home/k/work/scratch': [],
};
const CRUMBS: Record<string, readonly { name: string; path: string }[]> = {
  '/home/k': [{ name: '~', path: '/home/k' }],
  '/home/k/work': [
    { name: '~', path: '/home/k' },
    { name: 'work', path: '/home/k/work' },
  ],
  '/home/k/work/scratch': [
    { name: '~', path: '/home/k' },
    { name: 'work', path: '/home/k/work' },
    { name: 'scratch', path: '/home/k/work/scratch' },
  ],
};

const listingFor = (call: Call) => {
  const path = call.query?.path ?? '/home/k';
  const hidden = call.query?.hidden === '1';
  return {
    path,
    crumbs: CRUMBS[path] ?? CRUMBS['/home/k'],
    entries: (TREE[path] ?? []).filter(each => hidden || !each.hidden),
    truncated: false,
  };
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
};
const settled = (mounted: Mounted, ready: (container: HTMLElement) => boolean, what: string) =>
  settleUntil(() => ready(mounted.container), what, interact);
const press = (element: Element) => interact(() => element.dispatchEvent(clickEvent()));
const names = (mounted: Mounted): string[] =>
  [...mounted.container.querySelectorAll('[data-explorer-entry]')].map(
    node => node.getAttribute('data-explorer-entry') ?? '',
  );
const crumbs = (mounted: Mounted): string[] =>
  [...mounted.container.querySelectorAll('[data-explorer-crumb]')].map(
    node => node.getAttribute('data-explorer-crumb') ?? '',
  );
const button = (mounted: Mounted, text: string): Element =>
  must(
    [...mounted.container.querySelectorAll('button')].find(node => (node.textContent ?? '').trim() === text),
    `the "${text}" button`,
  );
const listbox = (mounted: Mounted): Element => must(mounted.container.querySelector('[role="listbox"]'), 'the listbox');
const key = (element: Element, name: string) => interact(() => pressKey(element, name));

const open = async (
  calls: Call[] = [],
  extra: Record<string, unknown> = {},
  onChoose: (path: string) => void = () => {},
) => {
  const client = scripted({ [LIST]: listingFor, ...extra }, calls);
  const mounted = await mount(<FolderPicker client={client} onChoose={onChoose} />);
  await settled(mounted, c => c.querySelector('[data-explorer-state="ready"]') !== null, 'the explorer');
  return mounted;
};

describe('FolderExplorer', () => {
  it('opens at the home folder with folders first, files muted, and a git badge on a repository', async () => {
    explorerViewPreference.write('auto');
    const mounted = await open();
    expect(names(mounted)).toEqual(['work', 'notes.md']);
    expect(crumbs(mounted)).toEqual(['/home/k']);
    expect(
      must(mounted.container.querySelector('[data-explorer-kind="file"]'), 'a file').getAttribute('aria-disabled'),
    ).toBe('true');
    await press(must(mounted.container.querySelector('[data-explorer-entry="work"]'), 'work'));
    await settled(mounted, c => c.querySelector('[data-explorer-entry="ferretry"]') !== null, 'work opened');
    expect(crumbs(mounted)).toEqual(['/home/k', '/home/k/work']);
    expect(
      must(mounted.container.querySelector('[data-explorer-entry="ferretry"] [data-explorer-git-badge]'), 'the badge')
        .textContent,
    ).toBe('git');
    expect(mounted.container.querySelector('[data-explorer-entry="scratch"] [data-explorer-git-badge]')).toBeNull();
    await mounted.unmount();
  });

  it('a press on a file does nothing, and a crumb goes back up', async () => {
    const mounted = await open();
    await press(must(mounted.container.querySelector('[data-explorer-entry="notes.md"]'), 'the file'));
    await settle();
    expect(crumbs(mounted)).toEqual(['/home/k']);
    await press(must(mounted.container.querySelector('[data-explorer-entry="work"]'), 'work'));
    await settled(mounted, c => c.querySelector('[data-explorer-entry="scratch"]') !== null, 'work');
    await press(must(mounted.container.querySelector('[data-explorer-crumb="/home/k"]'), 'the home crumb'));
    await settled(mounted, c => c.querySelector('[data-explorer-entry="notes.md"]') !== null, 'home again');
    await mounted.unmount();
  });

  it('shows cards or a list, and remembers the choice on this device', async () => {
    explorerViewPreference.write('auto');
    const mounted = await open();
    // A desktop-sized happy-dom window is not a phone: cards.
    expect(listbox(mounted).getAttribute('data-explorer-view')).toBe('card');
    const list = must(
      mounted.container.querySelector<HTMLInputElement>('[data-explorer-view-choice="list"] input'),
      'the list radio',
    );
    await press(list);
    expect(listbox(mounted).getAttribute('data-explorer-view')).toBe('list');
    expect(explorerViewPreference.read()).toBe('list');
    await mounted.unmount();
    // A new mount reads it back.
    const again = await open();
    expect(listbox(again).getAttribute('data-explorer-view')).toBe('list');
    await again.unmount();
    explorerViewPreference.write('auto');
  });

  it('moves one highlight with the arrows, opens it with Enter and goes up with Backspace', async () => {
    const mounted = await open();
    const box = listbox(mounted);
    await key(box, 'ArrowDown');
    expect(box.getAttribute('aria-activedescendant')).toBe(
      must(mounted.container.querySelector('[data-explorer-entry="work"]'), 'work').id,
    );
    expect(mounted.container.querySelectorAll('[data-explorer-highlighted="true"]').length).toBe(1);
    await key(box, 'Enter');
    await settled(mounted, c => c.querySelector('[data-explorer-entry="scratch"]') !== null, 'work opened');
    // The highlight belongs to the folder it was made in.
    expect(mounted.container.querySelectorAll('[data-explorer-highlighted="true"]').length).toBe(0);
    await key(listbox(mounted), 'Backspace');
    await settled(mounted, c => c.querySelector('[data-explorer-entry="notes.md"]') !== null, 'back at home');
    // Backspace at the top stays at the top.
    await key(listbox(mounted), 'Backspace');
    await settle();
    expect(crumbs(mounted)).toEqual(['/home/k']);
    await mounted.unmount();
  });

  it('asks for hidden folders only when told to', async () => {
    const calls: Call[] = [];
    const mounted = await open(calls);
    expect(names(mounted)).not.toContain('.config');
    await press(must(mounted.container.querySelector('input[type="checkbox"]'), 'the hidden toggle'));
    await settled(mounted, c => c.querySelector('[data-explorer-entry=".config"]') !== null, 'hidden shown');
    expect(calls.at(-1)?.query).toEqual({ hidden: '1' });
    await mounted.unmount();
  });

  it('chooses the folder that is open', async () => {
    const chosen: string[] = [];
    const mounted = await open([], {}, path => chosen.push(path));
    await press(must(mounted.container.querySelector('[data-explorer-entry="work"]'), 'work'));
    await settled(mounted, c => c.querySelector('[data-explorer-entry="scratch"]') !== null, 'work');
    await press(button(mounted, 'Use this folder'));
    expect(chosen).toEqual(['/home/k/work']);
    expect(must(mounted.container.querySelector('[data-explorer-path]'), 'the path').textContent).toBe('/home/k/work');
    await mounted.unmount();
  });

  it('makes a folder inline, checks the name as you type, opens the new folder, and says a refusal as worded', async () => {
    const calls: Call[] = [];
    const mounted = await open(calls, {
      [MAKE]: (call: Call) => {
        const body = call.body as { parent: string; name: string };
        if (body.name === 'taken') return refusal(422, 'a folder named taken already exists');
        TREE[`${body.parent}/${body.name}`] = [];
        CRUMBS[`${body.parent}/${body.name}`] = [
          ...(CRUMBS[body.parent] ?? []),
          { name: body.name, path: `${body.parent}/${body.name}` },
        ];
        return { path: `${body.parent}/${body.name}` };
      },
    });
    await press(button(mounted, 'New folder'));
    const field = must(
      mounted.container.querySelector<HTMLInputElement>('[data-explorer-new-folder] input'),
      'the name field',
    );
    await interact(() => typeInto(field, '.nope'));
    expect(
      must(mounted.container.querySelector('[data-explorer-new-folder-problem]'), 'the problem').textContent,
    ).toContain('dot');
    expect(calls.some(call => call.route === MAKE)).toBe(false);

    await interact(() => typeInto(field, 'taken'));
    await press(button(mounted, 'Create'));
    await settled(
      mounted,
      c => c.querySelector('[data-explorer-new-folder-problem]')?.textContent === 'a folder named taken already exists',
      'the refusal',
    );
    // The name stays so nothing is retyped.
    expect(field.value).toBe('taken');

    await interact(() => typeInto(field, 'fresh'));
    await press(button(mounted, 'Create'));
    await settled(
      mounted,
      c => c.querySelector('[data-explorer-path]')?.textContent === '/home/k/fresh',
      'the new folder open',
    );
    expect(calls.filter(call => call.route === MAKE).at(-1)?.body).toEqual({ parent: '/home/k', name: 'fresh' });
    expect(mounted.container.querySelector('[data-explorer-new-folder]')).toBeNull();
    await mounted.unmount();
  });

  it('keeps the folder on screen when the next read fails, and says so', async () => {
    let fail = false;
    const client = scripted({
      [LIST]: (call: Call) => (fail ? refusal(403, 'that folder is private') : listingFor(call)),
    });
    const mounted = await mount(<FolderPicker client={client} onChoose={() => {}} />);
    await settled(mounted, c => c.querySelector('[data-explorer-state="ready"]') !== null, 'ready');
    fail = true;
    await press(must(mounted.container.querySelector('[data-explorer-entry="work"]'), 'work'));
    await settled(
      mounted,
      c => (c.querySelector('[role="alert"]')?.textContent ?? '').includes('that folder is private'),
      'the failure',
    );
    expect(names(mounted)).toEqual(['work', 'notes.md']);
    await mounted.unmount();
  });

  it('states a failed first read instead of drawing nothing', async () => {
    const client = scripted({ [LIST]: refusal(403, 'folders are off on this daemon') });
    const mounted = await mount(<FolderPicker client={client} onChoose={() => {}} />);
    await settled(mounted, c => c.querySelector('[data-explorer-state="failed"]') !== null, 'the failure');
    expect(mounted.container.textContent).toContain('folders are off on this daemon');
    await mounted.unmount();
  });

  it('says an empty folder is empty, and a cut-off listing is cut off', async () => {
    const client = scripted({
      [LIST]: (call: Call) =>
        call.query?.path === '/home/k/work/scratch'
          ? { ...listingFor(call), entries: [] }
          : { ...listingFor(call), truncated: true },
    });
    const mounted = await mount(<FolderPicker client={client} startAt="/home/k" onChoose={() => {}} />);
    await settled(mounted, c => c.querySelector('[data-explorer-truncated]') !== null, 'the cut-off sentence');
    await press(must(mounted.container.querySelector('[data-explorer-entry="work"]'), 'work'));
    await settled(mounted, c => c.querySelector('[data-explorer-entry="scratch"]') !== null, 'work');
    await press(must(mounted.container.querySelector('[data-explorer-entry="scratch"]'), 'scratch'));
    await settled(mounted, c => c.querySelector('[data-explorer-empty]') !== null, 'empty');
    await mounted.unmount();
  });
});
