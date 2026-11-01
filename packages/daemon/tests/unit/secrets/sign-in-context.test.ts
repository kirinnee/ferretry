/**
 * WHO IS ASKING, for the order of a sign-in card (R1-5, secrev-1240 M2): the project comes from the daemon's own
 * reading of the session, the folder is its recorded working directory (kept only while it is still its own real path) and only on the Unfiled
 * board, and a part that cannot be read is left out instead of failing the card.
 */
import { describe, it } from 'bun:test';
import { type AccountDefaultsFile, type ProjectInfo, UNFILED_PROJECT_ID } from '@ferretry/protocol';
import should from 'should';
import { SessionSignInContext } from '../../../src/lib/secrets/index.ts';

const DEFAULTS: AccountDefaultsFile = { sites: { 'github.com': 'A' } };
const project = (id: string, name: string): ProjectInfo =>
  ({ id, name, path: `/srv/${name}`, source: 'existing-folder', createdAt: '' }) as ProjectInfo;

function context(
  options: {
    board?: string | Error;
    projects?: readonly ProjectInfo[];
    cwd?: string | null | Error;
    real?: Record<string, string | undefined>;
    defaults?: AccountDefaultsFile | Error;
  } = {},
) {
  const asked: string[] = [];
  const subject = new SessionSignInContext({
    defaults: async () => {
      if (options.defaults instanceof Error) throw options.defaults;
      return options.defaults ?? DEFAULTS;
    },
    projectOf: async sessionId => {
      asked.push(sessionId);
      if (options.board instanceof Error) throw options.board;
      return (options.board ?? UNFILED_PROJECT_ID) as never;
    },
    projects: async () => options.projects ?? [],
    sessions: {
      read: async () => {
        if (options.cwd instanceof Error) throw options.cwd;
        return options.cwd === null ? null : { cwd: options.cwd ?? '/work/app' };
      },
    },
    realpath: async path => {
      const real = options.real ?? {};
      return path in real ? real[path] : path;
    },
    home: '/home/me',
  });
  return { subject, asked };
}

describe('the session behind a sign-in card', () => {
  it('should give the owner’s own request the defaults and nothing about a session', async () => {
    const { subject, asked } = context();

    should(await subject.of(undefined)).deepEqual({ defaults: DEFAULTS });
    should(asked).deepEqual([]);
  });

  it('should name the board project the DAEMON resolved, and whether its name is unique', async () => {
    const { subject, asked } = context({
      board: 'p1',
      projects: [project('p1', 'ferretry'), project('p2', 'other')],
    });

    should(await subject.of('s1')).deepEqual({
      defaults: DEFAULTS,
      project: { id: 'p1', name: 'ferretry', nameIsUnique: true },
    });
    should(asked).deepEqual(['s1']);
  });

  it('should not call a name unique when two projects share it', async () => {
    const { subject } = context({ board: 'p1', projects: [project('p1', 'app'), project('p2', 'app')] });

    should((await subject.of('s1')).project?.nameIsUnique).be.false();
  });

  it('should give a session on a project no folder, even though it has one', async () => {
    const { subject } = context({ board: 'p1', projects: [project('p1', 'ferretry')], cwd: '/work/app' });

    should(await subject.of('s1')).not.have.property('folder');
  });

  it('should give an Unfiled session its recorded folder, and the REAL path of the home', async () => {
    const { subject } = context({ cwd: '/srv/real/app', real: { '/home/me': '/data/home/me' } });

    should(await subject.of('s1')).deepEqual({ defaults: DEFAULTS, folder: '/srv/real/app', home: '/data/home/me' });
  });

  it('should give no folder default when the recorded folder now resolves elsewhere (a ferret swapped it for a symlink)', async () => {
    const { subject } = context({ cwd: '/tmp/wt', real: { '/tmp/wt': '/home/me/scratch' } });

    should(await subject.of('s1')).deepEqual({ defaults: DEFAULTS });
  });

  it('should leave the folder out when it cannot be resolved, and when the session is unknown', async () => {
    should(await context({ cwd: '/gone', real: { '/gone': undefined } }).subject.of('s1')).deepEqual({
      defaults: DEFAULTS,
    });
    should(await context({ cwd: null }).subject.of('s1')).deepEqual({ defaults: DEFAULTS });
    should(await context({ cwd: new Error('unreadable') }).subject.of('s1')).deepEqual({ defaults: DEFAULTS });
  });

  it('should fall to the site lines when the board, the projects or the defaults cannot be read', async () => {
    should(await context({ board: new Error('no board') }).subject.of('s1')).deepEqual({ defaults: DEFAULTS });
    should(await context({ board: 'gone', projects: [project('p1', 'x')] }).subject.of('s1')).deepEqual({
      defaults: DEFAULTS,
    });
    should((await context({ defaults: new Error('no file') }).subject.of('s1')).defaults).deepEqual({});
  });
});
