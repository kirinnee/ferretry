import { describe, it } from 'bun:test';
import should from 'should';
import { ferretPlace, pageUrlOf } from '../../../daemon/adapters/pending-reads.ts';

/** The two approved reads not on this base yet (TODO(contract)): each finds nothing until its porter adds the field. */
const handle = <Api>(api: Api | undefined) => ({ current: () => api });

describe('the reads Accounts takes from Browsers and Ferrets', () => {
  it('I184 should read where a ferret works from Ferrets, and nothing when Ferrets is off or says nothing', async () => {
    const ferrets = {
      get: async (id: string) =>
        id === 'F1' ? { id, folder: '/work/app', project: 'p1' } : id === 'F2' ? { id } : undefined,
    };
    should(await ferretPlace(handle(ferrets) as never, 'F1')).eql({ folder: '/work/app', project: 'p1' });
    should(await ferretPlace(handle(ferrets) as never, 'F2')).eql({});
    should(await ferretPlace(handle(ferrets) as never, 'F3')).be.undefined();
    should(await ferretPlace(handle(undefined) as never, 'F1')).be.undefined();
    const failing = { get: async () => Promise.reject(new Error('down')) };
    should(await ferretPlace(handle(failing) as never, 'F1')).be.undefined();
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
