import { describe, it } from 'bun:test';
import should from 'should';
import { agentControlRefusal, ApiError } from '@ferretry/kernel/contract';
import {
  boardProjectOf,
  ownerFerretOf,
  pageAddressOf,
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
    should(
      await ownerFerretOf(handle({ list: async () => Promise.reject(new Error('down')) }) as never),
    ).be.undefined();
    should(await registeredProjects(handle({ list: async () => Promise.reject(new Error('down')) }) as never)).eql([]);
  });

  it('S13 should read a named page’s address through Browsers’ gated read, for the asking ferret alone', async () => {
    const asked: [string, string][] = [];
    const browsers = {
      pageAddressOf: async (id: string, name: string) => {
        asked.push([id, name]);
        return id === 'F1' ? 'https://github.com' : undefined;
      },
    };
    should(await pageAddressOf(handle(browsers) as never, 'F1', 'app')).equal('https://github.com');
    should(await pageAddressOf(handle(browsers) as never, 'F2', 'app')).be.undefined();
    should(asked).eql([
      ['F1', 'app'],
      ['F2', 'app'],
    ]);
  });

  it('S13 should offer no address when Browsers is off, offers no gated read, reads nothing from pagesOf, or fails', async () => {
    should(await pageAddressOf(handle(undefined) as never, 'F1', 'app')).be.undefined();
    // `pagesOf` asks no switch: an address is never taken from it, whatever a page row carries.
    const ungated = { pagesOf: async () => [{ id: 'p1', name: 'app', url: 'https://github.com/login' }] };
    should(await pageAddressOf(handle(ungated) as never, 'F1', 'app')).be.undefined();
    const failing = { pageAddressOf: async () => Promise.reject(new Error('down')) };
    should(await pageAddressOf(handle(failing) as never, 'F1', 'app')).be.undefined();
    // Only the Browsers-switch refusal is let through: another 403 is not it.
    const other = { pageAddressOf: async () => Promise.reject(new ApiError(403, 'not this one', 'forbidden')) };
    should(await pageAddressOf(handle(other) as never, 'F1', 'app')).be.undefined();
  });

  it('S13 should let Browsers’ refusal through unchanged while the Browsers switch is off, never swallowing it', async () => {
    const refusal = new ApiError(403, agentControlRefusal('browser'), 'forbidden');
    const off = { pageAddressOf: async () => Promise.reject(refusal) };
    await should(pageAddressOf(handle(off) as never, 'F1', 'app')).be.rejectedWith(refusal);
  });
});
