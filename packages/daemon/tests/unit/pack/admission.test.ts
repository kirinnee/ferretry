import { describe, it } from 'bun:test';
import should from 'should';
import { admitChild, depthOf, type Lineage, packInstructed } from '../../../src/lib/pack/admission.ts';
import { packConfig } from './support.ts';

const LIMITS = packConfig().limits;

describe('admitChild', () => {
  it('should refuse a parent whose child would sit deeper than the limit, singular and plural', () => {
    // Arrange
    const top = { id: 'a', interactive: true, depth: 2, runningChildren: 0 };
    const nested = { ...top, id: 'b', depth: 1 };

    // Act
    const deep = admitChild(top, LIMITS);
    const shallow = admitChild(nested, { ...LIMITS, maxDepth: 1 });

    // Assert
    should(deep?.code).equal('depth_exceeded');
    should(deep?.message).equal('a is 2 levels deep; sub-ferrets may nest 2 deep, so it may not start its own.');
    should(shallow?.message).equal('b is 1 level deep; sub-ferrets may nest 1 deep, so it may not start its own.');
    should(deep?.remedy).equal('Do this part yourself.');
  });

  it('should hold an interactive parent to 20 and an unattended one to 4', () => {
    // Arrange
    const interactive = { id: 'i', interactive: true, depth: 0, runningChildren: 19 };
    const unattended = { id: 'u', interactive: false, depth: 0, runningChildren: 4 };

    // Act
    const roomy = admitChild(interactive, LIMITS);
    const full = admitChild(unattended, LIMITS);
    const fullInteractive = admitChild({ ...interactive, runningChildren: 20 }, LIMITS);

    // Assert
    should(roomy).be.undefined();
    should(full?.code).equal('limit_reached');
    should(full?.message).equal('u already has 4 running sub-ferrets, the most an unattended ferret may have (4).');
    should(fullInteractive?.message).equal(
      'i already has 20 running sub-ferrets, the most an interactive ferret may have (20).',
    );
  });

  it('should say "sub-ferret" in the singular when the limit is one', () => {
    // Arrange
    const parent = { id: 'p', interactive: false, depth: 0, runningChildren: 1 };

    // Act
    const refusal = admitChild(parent, { ...LIMITS, autoChildren: 1 });

    // Assert
    should(refusal?.message).equal('p already has 1 running sub-ferret, the most an unattended ferret may have (1).');
  });

  it('should let a parent with room start a child', () => {
    // Arrange
    const parent = { id: 'p', interactive: false, depth: 1, runningChildren: 0 };

    // Act
    const refusal = admitChild(parent, LIMITS);

    // Assert
    should(refusal).be.undefined();
  });
});

describe('packInstructed', () => {
  it('should tell a ferret only when the machine, its own switch and its depth all allow it', () => {
    // Arrange
    const on = packConfig();

    // Act
    const top = packInstructed(on, undefined, 0);
    const explicitOn = packInstructed(on, true, 1);
    const ownOff = packInstructed(on, false, 0);
    const machineOff = packInstructed(packConfig({ enabled: false }), true, 0);
    const deepest = packInstructed(on, true, 2);

    // Assert
    should([top, explicitOn, ownOff, machineOff, deepest]).deepEqual([true, true, false, false, false]);
  });
});

describe('depthOf', () => {
  const tree = (rows: Readonly<Record<string, Lineage>>) => async (id: string) => rows[id];

  it('should count the parents above a session', async () => {
    // Arrange
    const read = tree({ c: { parent: 'b' }, b: { parent: 'a' }, a: {} });

    // Act
    const depths = await Promise.all([depthOf('a', read), depthOf('b', read), depthOf('c', read)]);

    // Assert
    should(depths).deepEqual([0, 1, 2]);
  });

  it('should stop at a loop instead of running forever', async () => {
    // Arrange
    const read = tree({ a: { parent: 'b' }, b: { parent: 'a' } });

    // Act
    const depth = await depthOf('a', read);

    // Assert
    should(depth).equal(1);
  });

  it('should stop at an ancestor that is gone', async () => {
    // Arrange
    const read = tree({ c: { parent: 'b' }, b: { parent: 'ghost' } });

    // Act
    const depth = await depthOf('c', read);

    // Assert
    should(depth).equal(2);
  });

  it('should stop at the ceiling', async () => {
    // Arrange
    const read = async (id: string): Promise<Lineage> => ({ parent: `${id}x` });

    // Act
    const depth = await depthOf('s', read, 3);
    const standard = await depthOf('s', read);

    // Assert
    should(depth).equal(3);
    should(standard).equal(16);
  });

  it('should read a session with no record as top level', async () => {
    // Arrange
    const read = tree({});

    // Act
    const depth = await depthOf('nobody', read);

    // Assert
    should(depth).equal(0);
  });
});
