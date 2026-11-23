/**
 * The setup flow's last page, "Add your projects" (C59 O8-13): the Add project explorer to pick one folder or several, the
 * same registration when Next saves, a pass-over on a machine that already has a project, and the words the end page opens.
 */
import { describe, expect, it } from 'bun:test';
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
    const { recorder, mounted, calls } = await open({});
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
});
