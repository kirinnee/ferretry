import { describe, it } from 'bun:test';
import should from 'should';
import {
  boardProjectOf,
  ownerFerretOf,
  pageUrlOf,
  registeredProjects,
  workFolderOf,
} from '../../../daemon/adapters/pending-reads.ts';

const handle = <Api>(api: Api | undefined) => ({ current: () => api });

describe('the reads Accounts takes from Browsers, Ferrets, the Board and Projects', () => {
  it('I184 should read a ferret’s real work folder from Ferrets, and nothing when Ferrets is off or says nothing', async () => {
    const ferrets = { workFolder: async (id: string) => (id === 'F1' ? { folder: '/work/app' } : undefined) };
    should(await workFolderOf(handle(ferrets) as never, 'F1')).equal('/work/app');
    should(await workFolderOf(handle(ferrets) as never, 'F2')).be.undefined();
    should(await workFolderOf(handle(undefined) as never, 'F1')).be.undefined();
    const failing = { workFolder: async () => Promise.reject(new Error('down')) };
    should(await workFolderOf(handle(failing) as never, 'F1')).be.undefined();
  });

  it('I184 should read the project from the Board, nothing when the Board is off or fails, and name it from Projects', async () => {
    const board = { projectOf: async (id: string) => (id === 'F1' ? 'p1' : 'unfiled') };
    should(await boardProjectOf(handle(board) as never, 'F1')).equal('p1');
    should(await boardProjectOf(handle(board) as never, 'F2')).equal('unfiled');
    should(await boardProjectOf(handle({}) as never, 'F1')).be.undefined();
    should(await boardProjectOf(handle(undefined) as never, 'F1')).be.undefined();
    const failing = { projectOf: async () => Promise.reject(new Error('down')) };
    should(await boardProjectOf(handle(failing) as never, 'F1')).be.undefined();
    const projects = { list: async () => [{ id: 'p1', name: 'App', path: '/work/app' }] };
    should(await registeredProjects(handle(projects) as never)).eql([{ id: 'p1', name: 'App' }]);
    should(await registeredProjects(handle(undefined) as never)).eql([]);
  });

  it('I173 should pick the most recently active ferret that has not ended for an owner’s own card', async () => {
    const ferrets = {
      list: async () => [
        { id: 'F1', state: 'working', stateAt: '2026-11-01T10:00:00.000Z' },
        { id: 'F2', state: 'idle', stateAt: '2026-11-01T11:00:00.000Z' },
        { id: 'F3', state: 'stopped', stateAt: '2026-11-01T12:00:00.000Z' },
      ],
    };
    should(await ownerFerretOf(handle(ferrets) as never)).equal('F2');
    should(await ownerFerretOf(handle({ list: async () => [] }) as never)).be.undefined();
    should(await ownerFerretOf(handle(undefined) as never)).be.undefined();
  });

  it('S13 should read a named page’s address only from the caller’s own pages', async () => {
    const browsers = {
      pagesOf: async (id: string) => (id === 'F1' ? [{ id: 'p1', name: 'app', url: 'https://github.com/login' }] : []),
    };
    should(await pageUrlOf(handle(browsers) as never, 'F1', 'app')).equal('https://github.com/login');
    should(await pageUrlOf(handle(browsers) as never, 'F2', 'app')).be.undefined();
    should(await pageUrlOf(handle(undefined) as never, 'F1', 'app')).be.undefined();
  });
});
