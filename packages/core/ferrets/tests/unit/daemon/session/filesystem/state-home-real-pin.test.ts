import { afterEach, describe, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath, FerretId, WorkFolders } from '@ferretry/kernel/contract';
import { nodeFs, rootsPortFor } from '@ferretry/kernel/host';
import { err, ok } from '@ferretry/std';
// The kernel's own pin registry and platform pinner: the REAL pin a ferret's `work` root hands out, not a fake.
import { platformRootPinner } from '../../../../../../kernel/host/adapters/pinned/index.ts';
import { PinRegistry } from '../../../../../../kernel/host/pins.ts';
import { KernelSessionRootPinner } from '../../../../../daemon/adapters/session/filesystem/index.ts';
import {
  AGENT_READ_FENCE,
  FsError,
  type SessionChangesView,
  SessionFilesystem,
} from '../../../../../daemon/lib/session/filesystem/index.ts';
import { FakeSessionGit, type SessionGitScript } from './support.ts';

/**
 * S47 over the REAL kernel pin (today's `fenceRefusal`, `homeRefusal`, `hardLinkRefusal`, the changes filter and the
 * listing / index `denied`): a ferret working in `~`, whose work folder holds the state home. The walk is the kernel's
 * descriptor walk; only Git's answers are scripted, because what is under test is what the service does with names
 * Git hands it — names that never pass through the walk.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const TOKEN = 'fy_admin_fixture';
const VAULT = 'vault-fixture';

/** `<parent>` is the work folder; the state home is `<parent>/.ferretry`. */
async function layout() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-s47-real-pin-`));
  parents.push(parent);
  const home = `${parent}/.ferretry`;
  await mkdir(`${home}/state/vault`, { recursive: true });
  await writeFile(`${home}/api-token`, TOKEN);
  await writeFile(`${home}/state/vault/ledger.txt`, VAULT);
  await writeFile(`${parent}/notes.md`, 'notes');
  await mkdir(`${parent}/src`);
  await writeFile(`${parent}/src/a.ts`, 'source');
  return { parent, home };
}

const workFolders = (folder: string): WorkFolders => ({
  folderOf: () => folder as FencedPath,
  check: (_ferret, path) => (path.startsWith(folder) ? ok(path as FencedPath) : err('outside')),
});

/** The service as Ferrets builds it: the ferret's `work` root, pinned by the kernel. */
function viewer(home: string, work: string, script: SessionGitScript = {}) {
  const roots = rootsPortFor(
    nodeFs(() => 'r'),
    { home, plugin: 'ferrets', worktrees: `${home}-worktrees` },
    ['work'],
    () => workFolders(work),
    { pins: new PinRegistry(() => platformRootPinner()) },
  );
  const root = roots.root('work', { ferret: 'F1' as FerretId });
  return new SessionFilesystem(new KernelSessionRootPinner(root), new FakeSessionGit(script));
}

/** The viewer's refusal code a read came to, or `served`. */
async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'served';
  } catch (error) {
    if (error instanceof FsError) return error.code;
    throw error;
  }
}

const agent = { fence: AGENT_READ_FENCE };

describe('S47 an agent behind the real kernel pin', () => {
  test('S47 an agent rev=head read of a tracked file under the home is refused denied before Git is asked; a person reads it', async () => {
    const { parent, home } = await layout();
    const asked: string[] = [];
    const filesystem = viewer(home, parent, {
      readHeadBlob: (_cwd, rel) => {
        asked.push(rel);
        return { size: TOKEN.length, bytes: new TextEncoder().encode(TOKEN) };
      },
    });

    expect(await codeOf(filesystem.readFile(parent, '.ferretry/api-token', { rev: 'head', ...agent }))).toBe('denied');
    expect(await codeOf(filesystem.readFile(parent, '.ferretry/gone.json', { rev: 'head', ...agent }))).toBe('denied');
    expect(asked).toEqual([]);

    const person = await filesystem.readFile(parent, '.ferretry/api-token', { rev: 'head' });
    expect(person.content).toBe(TOKEN);
    expect(asked).toEqual(['.ferretry/api-token']);
  });

  test('S47 an agent change list omits every name under the home, untracked or renamed from it; a person sees them all', async () => {
    const { parent, home } = await layout();
    const view: SessionChangesView = {
      repo: true,
      changes: [
        { path: 'notes.md', status: ' M' },
        { path: '.ferretry/state/vault/ledger.txt', status: '??' },
        { path: '.ferretry/never-made.txt', status: '??' },
        { path: 'moved.txt', from: '.ferretry/api-token', status: 'R ' },
        { path: 'src/deleted.ts', status: ' D' },
      ],
    };
    const filesystem = viewer(home, parent, { changes: () => view });

    const forAgent = await filesystem.changes(parent, agent);
    expect(forAgent.changes.map(change => change.path)).toEqual(['notes.md', 'src/deleted.ts']);

    const forPerson = await filesystem.changes(parent);
    expect(forPerson.changes.map(change => change.path)).toEqual(view.changes.map(change => change.path));
  });

  test('S47 an agent listing badges the home denied and the index walk counts it denied; a person lists into it', async () => {
    const { parent, home } = await layout();
    const filesystem = viewer(home, parent, { repoInfo: () => ({ repo: false, prefix: '', hasHead: false }) });

    const listing = await filesystem.list(parent, undefined, agent);
    const badge = (name: string) => listing.entries.find(entry => entry.name === name)?.denied;
    expect(badge('.ferretry')).toBe(true);
    expect(badge('notes.md')).toBeUndefined();
    expect(badge('src')).toBeUndefined();
    expect(await codeOf(filesystem.list(parent, '.ferretry', agent))).toBe('denied');

    const index = await filesystem.index(parent, agent);
    expect(index.files.map(file => file.path).sort()).toEqual(['notes.md', 'src/a.ts']);
    expect(index.skipped.find(skip => skip.reason === 'denied')?.count).toBe(1);
    expect(index.skipped.find(skip => skip.reason === 'unreadable')).toBeUndefined();

    const person = await filesystem.list(parent);
    expect(person.entries.find(entry => entry.name === '.ferretry')?.denied).toBeUndefined();
    expect((await filesystem.list(parent, '.ferretry')).entries.map(entry => entry.name).sort()).toEqual([
      'api-token',
      'state',
    ]);
  });

  test('S47 a person reads inside the home and a hard-linked file as today; an agent is refused both', async () => {
    const { parent, home } = await layout();
    await link(`${home}/state/vault/ledger.txt`, `${parent}/twin`);
    const filesystem = viewer(home, parent);

    expect((await filesystem.readFile(parent, '.ferretry/state/vault/ledger.txt')).content).toBe(VAULT);
    expect((await filesystem.readFile(parent, 'twin')).content).toBe(VAULT);

    expect(await codeOf(filesystem.readFile(parent, '.ferretry/state/vault/ledger.txt', agent))).toBe('denied');
    expect(await codeOf(filesystem.readFile(parent, 'twin', agent))).toBe('denied');
    expect((await filesystem.readFile(parent, 'notes.md', agent)).content).toBe('notes');
  });

  test('S47 S40 a key file linked into the work folder under an innocent name is refused for an agent by identity, in every surface', async () => {
    const { parent, home } = await layout();
    await mkdir(`${parent}/elsewhere`);
    await link(`${home}/api-token`, `${parent}/elsewhere/innocent.txt`);
    const filesystem = viewer(home, parent, {
      changes: () => ({
        repo: true,
        changes: [
          { path: 'elsewhere/innocent.txt', status: '??' },
          { path: 'notes.md', status: ' M' },
        ],
      }),
    });

    expect(await codeOf(filesystem.readFile(parent, 'elsewhere/innocent.txt', agent))).toBe('denied');
    expect(await codeOf(filesystem.readFile(parent, 'elsewhere/innocent.txt', { rev: 'head', ...agent }))).toBe(
      'denied',
    );
    expect((await filesystem.changes(parent, agent)).changes.map(change => change.path)).toEqual(['notes.md']);
    const listing = await filesystem.list(parent, 'elsewhere', agent);
    expect(listing.entries.find(entry => entry.name === 'innocent.txt')?.denied).toBe(true);

    expect((await filesystem.readFile(parent, 'elsewhere/innocent.txt')).content).toBe(TOKEN);
  });
});
