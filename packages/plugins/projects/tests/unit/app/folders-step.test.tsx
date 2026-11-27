/**
 * The setup flow's last page, "Add your projects" (C59 O8-13): the Add project explorer to pick one folder or several, the
 * same registration when Next saves, a pass-over on a machine that already has a project, and the words the end page opens.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import { FoldersStep } from '../../../app/views/folders-step.tsx';
import { ANSWERED, type Call, clickEvent, PROJECT, refusal, scripted } from './support/client.ts';
import { stepRecorder } from './support/step-recorder.ts';

const LIST = 'GET /v1/projects';
const FOLDERS = 'GET /v1/projects/folders';
const REGISTER = 'POST /v1/projects';
const at = '2026-08-01T10:00:00.000Z';

const folder = (name: string) => ({ name, kind: 'folder' as const, isRepo: false, hidden: false, modifiedAt: at });
const TREE: Record<string, readonly ReturnType<typeof folder>[]> = {
  '/home/k': [folder('atlas'), folder('notes')],
  '/home/k/atlas': [],
  '/home/k/notes': [],
};
const listingFor = (call: Call) => {
  const path = call.query?.path ?? '/home/k';
  return {
    path,
    crumbs: [{ name: '~', path: '/home/k' }],
    entries: TREE[path] ?? [],
    truncated: false,
  };
};

const open = async (routes: Record<string, unknown>, calls: Call[] = []) => {
  const recorder = stepRecorder('client');
  const client = scripted({ [LIST]: [], [FOLDERS]: listingFor, [REGISTER]: ANSWERED, ...routes }, calls);
  const mounted = await mount(<FoldersStep step={recorder.host} client={client} daemon="workstation" />);
  await settleUntil(
    () => recorder.calls.some(call => call === 'ready' || call === 'notNeeded'),
    'the page decides',
    interact,
  );
  return { recorder, mounted, calls };
};
const press = (element: Element) => interact(() => element.dispatchEvent(clickEvent()));
const addThisFolder = (mounted: Mounted): Promise<void> => {
  const add = [...mounted.container.querySelectorAll('button')].find(
    node => (node.textContent ?? '').trim() === 'Add this folder',
  );
  return press(must(add, 'the Add this folder button'));
};
const picks = (mounted: Mounted): string[] =>
  [...mounted.container.querySelectorAll('[data-projects-step-picks] li')].map(node => node.textContent ?? '');

describe('the Add your projects step', () => {
  it('is passed over (not recorded, nothing drawn first) on a machine that already has a project', async () => {
    const { recorder } = await open({ [LIST]: [PROJECT] });
    expect(recorder.calls).toContain('notNeeded');
    expect(recorder.calls).not.toContain('ready');
  });

  it('shows itself on a machine with no project, and Next with nothing picked says how to leave', async () => {
    const { recorder } = await open({});
    expect(recorder.decision).toBe('shown');
    await expect(must(recorder.committed, 'a save').call(null)).rejects.toThrow('Skip for now');
  });

  it('picks several folders, registers each as an existing folder on Next, and leaves where they are', async () => {
    // Each folder is its own project (the daemon mints one record per folder).
    const { recorder, mounted, calls } = await open({
      [REGISTER]: (call: Call) => ({
        ...ANSWERED,
        id: (call.body as { path: string }).path === '/home/k' ? ANSWERED.id : '44444444-4444-4444-8444-444444444444',
      }),
    });
    await settleUntil(
      () => mounted.container.querySelector('[data-explorer-state="ready"]') !== null,
      'the explorer',
      interact,
    );
    await addThisFolder(mounted);
    await press(must(mounted.container.querySelector('[data-explorer-entry="atlas"]'), 'atlas'));
    await settleUntil(
      () => mounted.container.querySelector('[data-explorer-state="ready"]') !== null,
      'atlas',
      interact,
    );
    await addThisFolder(mounted);
    expect(picks(mounted)).toHaveLength(2);
    await must(recorder.committed, 'a save').call(null);
    const bodies = calls.filter(call => call.route === REGISTER).map(call => call.body);
    expect(bodies).toEqual([
      { kind: 'existing-folder', path: '/home/k' },
      { kind: 'existing-folder', path: '/home/k/atlas' },
    ]);
    expect(recorder.segment.openLabel).toBe('Open your projects');
    expect(recorder.segment.openHref).toBe('/d/workstation/projects');
    expect(recorder.segment.linkProjectId).toBeUndefined();
  });

  it('one folder opens that project: its name and its own address', async () => {
    const { recorder, mounted } = await open({});
    await settleUntil(
      () => mounted.container.querySelector('[data-explorer-state="ready"]') !== null,
      'the explorer',
      interact,
    );
    await addThisFolder(mounted);
    await must(recorder.committed, 'a save').call(null);
    expect(recorder.segment.openLabel).toBe('Open scratch');
    expect(recorder.segment.openHref).toBe(`/d/workstation/projects/${ANSWERED.id}`);
    // The next page (Connect GitHub) can link an account to the one project made here; two folders offer no such link.
    expect(recorder.segment.linkProjectId).toBe(ANSWERED.id);
    expect(recorder.segment.linkProjectName).toBe('scratch');
  });

  const pickFirstFolder = async (mounted: Mounted): Promise<void> => {
    await settleUntil(
      () => mounted.container.querySelector('[data-explorer-state="ready"]') !== null,
      'the explorer',
      interact,
    );
    await addThisFolder(mounted);
  };

  it('a folder the registry ALREADY held is not a project made here: no link is offered (the daemon answers its old record)', async () => {
    // The page reads an empty registry when it opens; by the time Next registers, the project exists (a ferret or `fy project add` made it).
    let reads = 0;
    const { recorder, mounted } = await open({ [LIST]: () => (reads++ === 0 ? [] : [ANSWERED]) });
    await pickFirstFolder(mounted);
    await must(recorder.committed, 'a save').call(null);
    expect(recorder.segment.openLabel).toBe('Open scratch');
    expect(recorder.segment.linkProjectId).toBeUndefined();
    expect(recorder.segment.madeIds).toBe('');
  });

  it('a registry that cannot be read before registering proves nothing: no link is offered', async () => {
    let reads = 0;
    const { recorder, mounted } = await open({
      [LIST]: () => {
        if (reads++ === 0) return [];
        throw refusal(500, 'the registry is busy');
      },
    });
    await pickFirstFolder(mounted);
    await must(recorder.committed, 'a save').call(null);
    expect(recorder.segment.linkProjectId).toBeUndefined();
  });

  it('Back from the next page lands here and STAYS: the project this run made does not pass the page over, and Next keeps it', async () => {
    let made = false;
    const { recorder, mounted, calls } = await open({
      [LIST]: () => (made ? [ANSWERED] : []),
      [REGISTER]: () => {
        made = true;
        return ANSWERED;
      },
    });
    await pickFirstFolder(mounted);
    await must(recorder.committed, 'a save').call(null);
    expect(recorder.segment.madeIds).toBe(ANSWERED.id);
    expect(recorder.segment.linkProjectId).toBe(ANSWERED.id);
    await mounted.unmount();
    // Back: the page is drawn again over the same segment memory, on a registry that now holds the project.
    const again = await mount(
      <FoldersStep
        step={recorder.host}
        client={scripted({ [LIST]: [ANSWERED], [FOLDERS]: listingFor, [REGISTER]: ANSWERED }, calls)}
        daemon="workstation"
      />,
    );
    await settleUntil(
      () => recorder.count('ready') === 2 || recorder.count('notNeeded') > 0,
      'the page decides',
      interact,
    );
    expect(recorder.count('notNeeded')).toBe(0);
    expect(recorder.count('ready')).toBe(2);
    expect(again.container.querySelector('[data-projects-step-made]')?.textContent).toContain(
      '1 project is already added',
    );
    // Next with nothing new picked moves on and keeps what was made (no error, nothing registered twice, the link stands).
    await must(recorder.committed, 'a save').call(null);
    expect(calls.filter(call => call.route === REGISTER)).toHaveLength(1);
    expect(recorder.segment.linkProjectId).toBe(ANSWERED.id);
    await again.unmount();
  });

  it('a refusal keeps the page with the folder still picked, says why, and remembers nothing to open', async () => {
    const { recorder, mounted } = await open({ [REGISTER]: refusal(422, 'that folder cannot be a project') });
    await settleUntil(
      () => mounted.container.querySelector('[data-explorer-state="ready"]') !== null,
      'the explorer',
      interact,
    );
    await addThisFolder(mounted);
    await expect(must(recorder.committed, 'a save').call(null)).rejects.toThrow('that folder cannot be a project');
    expect(picks(mounted)).toHaveLength(1);
    expect(recorder.segment.openLabel).toBeUndefined();
  });

  it("registers the save again when the person adds or removes a folder (that clears the footer's old message), never on its own refusal", async () => {
    const { recorder, mounted } = await open({ [REGISTER]: refusal(422, 'that folder cannot be a project') });
    await pickFirstFolder(mounted);
    const afterAdd = recorder.count('commit');
    await expect(must(recorder.committed, 'a save').call(null)).rejects.toThrow('that folder cannot be a project');
    await interact(() => undefined);
    // The refusal re-registered nothing: the frame clears its message on a registration, so one here would erase it.
    expect(recorder.count('commit')).toBe(afterAdd);
    await press(must(mounted.container.querySelector('[aria-label^="Remove "]'), 'the remove button'));
    expect(picks(mounted)).toHaveLength(0);
    expect(recorder.count('commit')).toBe(afterAdd + 1);
    await expect(must(recorder.committed, 'a save').call(null)).rejects.toThrow('Skip for now');
  });
});

describe('the Add your projects step keeps its work per save (E-257)', () => {
  // The draft lives in the browser's storage; one test's draft must never answer another's.
  afterEach(() => localStorage.clear());

  const ATLAS = '/home/k/atlas';
  /** `/home/k` registers; the atlas folder is refused. The registry holds the first once it is made. */
  const halfRefused = () => {
    let made = false;
    return {
      [LIST]: () => (made ? [ANSWERED] : []),
      [REGISTER]: (call: Call) => {
        if ((call.body as { path: string }).path === ATLAS) throw refusal(422, 'that folder cannot be a project');
        made = true;
        return ANSWERED;
      },
    };
  };
  const pickBoth = async (mounted: Mounted): Promise<void> => {
    await settleUntil(
      () => mounted.container.querySelector('[data-explorer-state="ready"]') !== null,
      'the explorer',
      interact,
    );
    await addThisFolder(mounted);
    await press(must(mounted.container.querySelector('[data-explorer-entry="atlas"]'), 'atlas'));
    await settleUntil(
      () => mounted.container.querySelector('[data-explorer-state="ready"]') !== null,
      'atlas',
      interact,
    );
    await addThisFolder(mounted);
  };
  const reopen = async (recorder: ReturnType<typeof stepRecorder>, routes: Record<string, unknown>) => {
    const again = await mount(
      <FoldersStep step={recorder.host} client={scripted({ [FOLDERS]: listingFor, ...routes })} daemon="workstation" />,
    );
    await settleUntil(
      () => recorder.calls.some(call => call === 'ready' || call === 'notNeeded'),
      'the page decides',
      interact,
    );
    return again;
  };

  it('a refusal on the second folder keeps the first made, the refused one still picked, when the page is drawn again', async () => {
    const routes = halfRefused();
    const { recorder, mounted } = await open(routes);
    await pickBoth(mounted);
    await expect(must(recorder.committed, 'a save').call(null)).rejects.toThrow('cannot be a project');
    expect(recorder.segment.madeIds).toBe(ANSWERED.id);
    await mounted.unmount();
    const again = await reopen(recorder, routes);
    expect(recorder.count('notNeeded')).toBe(0);
    expect(picks(again)).toEqual([ATLAS]);
    await again.unmount();
  });

  it('a reload (the run memory gone) keeps the refused folder picked and still does not pass the page over', async () => {
    const routes = halfRefused();
    const { recorder, mounted } = await open(routes);
    await pickBoth(mounted);
    await expect(must(recorder.committed, 'a save').call(null)).rejects.toThrow('cannot be a project');
    await mounted.unmount();
    const fresh = stepRecorder('client');
    const again = await reopen(fresh, routes);
    expect(fresh.count('notNeeded')).toBe(0);
    expect(fresh.count('ready')).toBe(1);
    expect(picks(again)).toEqual([ATLAS]);
    await again.unmount();
  });

  it('a finished save leaves no draft: a later visit to a machine with a project passes the page over', async () => {
    const { recorder, mounted } = await open({});
    await pickBoth(mounted);
    await must(recorder.committed, 'a save').call(null);
    await mounted.unmount();
    const fresh = stepRecorder('client');
    const again = await reopen(fresh, { [LIST]: [ANSWERED], [REGISTER]: ANSWERED });
    expect(fresh.count('notNeeded')).toBe(1);
    await again.unmount();
  });
});
