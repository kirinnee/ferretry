import { describe, it } from 'bun:test';
import should from 'should';
import { StorageSessionFacts } from '../../../src/adapters/board-projects/storage-session-facts.ts';

const SESSION = 'mvue6o6o-9af569ad';
const PROJECT = '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a10';

const facts = (config: unknown) => new StorageSessionFacts({ readConfig: () => Promise.resolve(config) });

describe('the stored session facts', () => {
  it('should read cwd, parent and project from a stored config', async () => {
    should(await facts({ cwd: '/work', parent: 'mvuc7tsf-0c3d50df', projectId: PROJECT }).read(SESSION)).eql({
      cwd: '/work',
      parent: 'mvuc7tsf-0c3d50df',
      projectId: PROJECT,
    });
  });

  it('should leave out what the config does not have', async () => {
    should(await facts({ cwd: '/work' }).read(SESSION)).eql({ cwd: '/work' });
  });

  it('should answer null for an id that is not a session id', async () => {
    should(await facts({ cwd: '/work' }).read('../etc')).equal(null);
  });

  it('should answer null for a config it cannot read or that has no cwd', async () => {
    should(await new StorageSessionFacts({ readConfig: () => Promise.reject(new Error('gone')) }).read(SESSION)).equal(
      null,
    );
    should(await facts({ label: 'x' }).read(SESSION)).equal(null);
  });
});
