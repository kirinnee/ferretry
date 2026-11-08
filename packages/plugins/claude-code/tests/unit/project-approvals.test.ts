import { describe, expect, test } from 'bun:test';
import type { FencedPath, FerretId, RootHandle } from '@ferretry/kernel/contract';
import { err, type Instant, ok } from '@ferretry/std';
import { claudeCodeConformance, fakeClaudeCode } from '../../contract/testing/index.ts';
import { ClaudeProjectApprovals } from '../../daemon/lib/project-approvals.ts';

/**
 * Claude Code's own answer to MCP's `approvedProjectServers` (today's `ProjectMcpLaunch` home reads, fail closed):
 * read from the ferret's home through this plugin's root handle, held in memory here — no real home is touched.
 */

const FERRET = 'f1' as FerretId;
const ROOT = '/work/app';
const BROKEN = Symbol('broken');
const DIRECTORY = Symbol('directory');
type Entry = string | typeof BROKEN | typeof DIRECTORY;

/** A home as files by name; `BROKEN` fails to read (EACCES), `DIRECTORY` is not a regular file. */
function home(files: Readonly<Record<string, Entry>>, refused: readonly string[] = []): RootHandle {
  const at = (path: FencedPath): Entry | undefined => files[path.slice('/home/f1/'.length)];
  return {
    name: 'agent-homes',
    internal: true,
    resolve: relative =>
      refused.includes(relative) ? err('link_escape' as never) : ok(`/home/f1/${relative}` as FencedPath),
    stat: async path => {
      const entry = at(path);
      if (entry === undefined) return undefined;
      return {
        kind: entry === DIRECTORY ? 'directory' : 'file',
        size: typeof entry === 'string' ? entry.length : 1,
        modified: '2026-11-07T09:00:00.000Z' as Instant,
        mode: 0o600,
        links: 1,
      };
    },
    readText: async path => {
      const entry = at(path);
      if (entry === BROKEN) throw EACCES();
      return typeof entry === 'string' ? entry : '';
    },
    readBytes: async () => new Uint8Array(),
    writeText: async () => {
      throw new Error('the approval read never writes');
    },
    list: async () => [],
    remove: async () => {
      throw new Error('the approval read never removes');
    },
    readTail: () => Promise.reject(new Error('the approval read never reads a tail')),
    writeBytes: () => Promise.reject(new Error('the approval read never writes')),
    copyTree: () => Promise.reject(new Error('the approval read never copies')),
    ensurePrivateDirectory: () => Promise.reject(new Error('the approval read never makes a folder')),
    entries: () => Promise.reject(new Error('the approval read never lists')),
    lstat: () => Promise.reject(new Error('the approval read never asks lstat')),
    makeDirectory: () => Promise.reject(new Error('the approval read never makes a folder')),
    realPath: () => Promise.reject(new Error('the approval read never resolves')),
    pin: () => Promise.reject(new Error('the approval read never pins')),
    publish: () => Promise.reject(new Error('the fixture has no publish')),
    readDurable: () => Promise.reject(new Error('the fixture has no readDurable')),
    syncDirectory: () => Promise.reject(new Error('the fixture has no syncDirectory')),
    fileIdentity: () => Promise.reject(new Error('the fixture has no fileIdentity')),
  };
}

const EACCES = () => Object.assign(new Error('EACCES: the disk said no'), { code: 'EACCES' });

/** The plain `agent-homes` root: what is at the ferret home's own name (a folder unless a test says otherwise). */
function homes(at: 'directory' | 'file' | 'symlink' | 'nothing' | typeof BROKEN = 'directory'): RootHandle {
  return {
    ...home({}),
    resolve: relative => ok(`/homes/${relative}` as FencedPath),
    stat: () => Promise.reject(new Error('the home name is looked up, never followed')),
    lstat: async () => {
      if (at === BROKEN) throw EACCES();
      if (at === 'nothing') return undefined;
      return { kind: at, size: 1, modified: '2026-11-07T09:00:00.000Z' as Instant, mode: 0o700, links: 1 };
    },
  };
}

const approvalsOver = (homeOf: (ferret: FerretId) => RootHandle, plain: () => RootHandle = () => homes()) =>
  new ClaudeProjectApprovals(homeOf, plain);

const claudeJson = (project: Record<string, unknown>): string =>
  JSON.stringify({ oauthAccount: { emailAddress: 'someone@example.invalid' }, projects: { [ROOT]: project } });

const ask = (approvals: ClaudeProjectApprovals, servers: readonly string[] = ['docs', 'linear', 'tracker']) =>
  approvals.approvedProjectServers({ ferret: FERRET, root: ROOT, servers });

describe('Claude Code project server approvals', () => {
  test('approves a trusted, enabled server, keeps an unasked one pending and reports a disabled one', async () => {
    // Arrange
    const approvals = approvalsOver(() =>
      home({
        '.claude.json': claudeJson({
          hasTrustDialogAccepted: true,
          enabledMcpjsonServers: ['docs'],
          disabledMcpjsonServers: ['tracker'],
        }),
      }),
    );

    // Act / Assert
    expect(await ask(approvals)).toEqual({
      state: 'read',
      servers: { docs: 'approved', linear: 'pending', tracker: 'disabled' },
    });
  });

  test.each(['__proto__', 'constructor', 'toString'])(
    'a server named %s gets a decision of its own: disabled, pending or approved',
    async name => {
      // Arrange — one home per answer; the name is listed exactly as the others are.
      const answer = async (project: Record<string, unknown>) => {
        const result = await ask(
          approvalsOver(() => home({ '.claude.json': claudeJson(project) })),
          [name],
        );
        if (result.state !== 'read') throw new Error('the home was readable');
        return result.servers;
      };

      // Act
      const disabled = await answer({ hasTrustDialogAccepted: true, disabledMcpjsonServers: [name] });
      const pending = await answer({});
      const approved = await answer({ hasTrustDialogAccepted: true, enabledMcpjsonServers: [name] });

      // Assert — an OWN key each time (a plain `servers[name] = …` loses `__proto__`), never the prototype's.
      for (const [servers, expected] of [
        [disabled, 'disabled'],
        [pending, 'pending'],
        [approved, 'approved'],
      ] as const) {
        expect(Object.hasOwn(servers, name)).toBe(true);
        expect(servers[name]).toBe(expected);
        expect(Object.keys(servers)).toEqual([name]);
      }
    },
  );

  test('a deny in settings.json wins over an allow in the project, and enableAll approves the rest', async () => {
    // Arrange
    const approvals = approvalsOver(() =>
      home({
        '.claude.json': claudeJson({ hasTrustDialogAccepted: true, enabledMcpjsonServers: ['docs'] }),
        'settings.json': JSON.stringify({ enableAllProjectMcpServers: true, disabledMcpjsonServers: ['docs'] }),
      }),
    );

    // Act / Assert
    expect(await ask(approvals, ['docs', 'linear'])).toEqual({
      state: 'read',
      servers: { docs: 'disabled', linear: 'approved' },
    });
  });

  test('a fresh home (no documents, or empty ones) disables nothing: every server is pending', async () => {
    // Act
    const fresh = await ask(
      approvalsOver(() => home({})),
      ['docs'],
    );
    const empty = await ask(
      approvalsOver(() => home({ '.claude.json': '  ', 'settings.json': '' })),
      ['docs'],
    );

    // Assert
    expect(fresh).toEqual({ state: 'read', servers: { docs: 'pending' } });
    expect(empty).toEqual({ state: 'read', servers: { docs: 'pending' } });
  });

  test.each([
    ['not valid JSON', { '.claude.json': '{"projects": {', 'settings.json': '{}' }, []],
    ['refused by the disk', { '.claude.json': '{}', 'settings.json': BROKEN }, []],
    ['not a regular file', { '.claude.json': DIRECTORY }, []],
    ['refused by the root (a link out of the home)', { '.claude.json': '{}' }, ['settings.json']],
  ] as const)('fails closed when a home document is %s: unreadable, quoting nothing', async (_why, files, refused) => {
    // Arrange
    const approvals = approvalsOver(() => home(files, refused));

    // Act
    const answer = await ask(approvals);

    // Assert
    expect(answer.state).toBe('unreadable');
    expect(JSON.stringify(answer)).not.toContain('projects');
    expect(JSON.stringify(answer)).not.toContain('someone@example.invalid');
  });

  test("a ferret's first launch, before its home is made, answers pending without reading the home", async () => {
    // Arrange — nothing at the home's name; the home root itself would fail any read (the folder is not there).
    const missing = (): RootHandle => ({
      ...home({}),
      stat: () => Promise.reject(Object.assign(new Error('ENOENT: no such folder'), { code: 'ENOENT' })),
    });
    const approvals = approvalsOver(missing, () => homes('nothing'));

    // Act / Assert
    expect(await ask(approvals)).toEqual({
      state: 'read',
      servers: { docs: 'pending', linear: 'pending', tracker: 'pending' },
    });
  });

  test.each([
    ['a link', 'symlink', "The ferret's home is not a folder."],
    ['a file', 'file', "The ferret's home is not a folder."],
    ['refused by the disk', BROKEN, "The ferret's home could not be read (EACCES)."],
  ] as const)('a home name that is %s answers unreadable, and the home is not read', async (_what, at, reason) => {
    // Arrange — the documents would approve everything if they were read.
    const approving = home({
      '.claude.json': claudeJson({ hasTrustDialogAccepted: true, enableAllProjectMcpServers: true }),
    });
    const approvals = approvalsOver(
      () => approving,
      () => homes(at),
    );

    // Act
    const answer = await ask(approvals);

    // Assert
    expect(answer).toEqual({ state: 'unreadable', reason });
  });

  test('a ferret whose home cannot be opened answers unreadable', async () => {
    // Arrange
    const approvals = approvalsOver(() => {
      throw new Error('not declared');
    });

    // Act / Assert
    expect((await ask(approvals)).state).toBe('unreadable');
  });

  test('the fake answers every asked server, records the query, and passes the conformance suite', async () => {
    // Arrange
    const fake = fakeClaudeCode();

    // Act
    const answer = await fake.approvedProjectServers({ ferret: FERRET, root: ROOT, servers: ['docs'] });
    fake.setApprovals(() => ({ state: 'unreadable', reason: 'settings.json is not valid JSON.' }));

    // Assert
    expect(answer).toEqual({ state: 'read', servers: { docs: 'pending' } });
    expect(fake.approvalQueries).toEqual([{ ferret: FERRET, root: ROOT, servers: ['docs'] }]);
    expect((await fake.approvedProjectServers({ ferret: FERRET, root: ROOT, servers: [] })).state).toBe('unreadable');
    expect((await claudeCodeConformance(fakeClaudeCode)).ok).toBe(true);
  });
});
