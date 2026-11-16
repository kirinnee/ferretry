/**
 * R2 (M-1): a diamond of `profile/<base>` layers must not be read once per path on ANY public path that reads a profile's
 * stack: the catalogue's `components()`, `profiles()`, `previewProfile`, a proposed change and `republish` answer
 * correctly on a lattice of shared bases. Here the lattice is 4 deep; how fast the 20-deep one (2^20 paths, 42 small
 * files an agent can write) is answered is tests/perf/daemon/profile-diamond-paths.test.ts.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { latticeDocument, world } from '../../support/diamond-world.ts';

const DEPTH = 4;

describe('R2 a diamond of profile bases is answered correctly through every public path (M-1)', () => {
  it('R2 should read the model itself', () => {
    should(() => parseAccountModel(latticeDocument(DEPTH))).not.throw();
  });

  it('R2 should list the components, with who uses each', async () => {
    const mcp = (await world(DEPTH).components()).kinds.find(group => group.kind === 'mcp');
    should(mcp?.components.length).equal(10);
  });

  it('R2 should list the profiles', async () => {
    should((await world(DEPTH).profiles()).profiles.length).equal(10);
  });

  it('R2 should preview a profile draft that names the lattice', async () => {
    const value = await world(DEPTH).previewProfile({ layers: ['profile/a0', 'mcp/b0'], editing: undefined });
    should(value.refusal).be.undefined();
  });

  it('R2 should preview a draft that makes the lattice’s bottom name its top (a loop)', async () => {
    const value = await world(DEPTH).previewProfile({ layers: ['profile/a0'], editing: 'b4' });
    should(value.refusal).match(/would include itself/);
  });

  it('R2 should preview a draft that makes a middle profile name the top, with a base below it', async () => {
    const value = await world(DEPTH).previewProfile({
      layers: ['profile/a0', 'profile/b3', 'mcp/b1'],
      editing: 'a2',
    });
    should(value.refusal).match(/would include itself/);
  });

  it('R2 should refuse a proposed profile that makes the lattice’s bottom name its top', async () => {
    const value = await world(DEPTH)
      .propose({ kind: 'profile.put', name: 'b4', layers: ['profile/a0'], create: false })
      .then(
        () => 'proposed',
        (error: unknown) => (error as Error).message,
      );
    should(value).match(/would include itself/);
  });

  it('R2 should propose a change, which resolves every runtime’s profile as an apply does', async () => {
    const value = await world(DEPTH).propose({ kind: 'runtime.rename', name: 'second', to: 'renamed' });
    should(value).not.be.undefined();
  });

  it('R2 should republish', async () => {
    should(await world(DEPTH).republish()).equal('applied');
  });
});
