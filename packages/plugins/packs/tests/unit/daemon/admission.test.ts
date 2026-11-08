import { describe, it } from 'bun:test';
import should from 'should';
import {
  admitChild,
  depthOf,
  type Lineage,
  type PackLineageFacts,
  packEligibleInLineage,
  runningChildCount,
  packInstructed,
  packLaunchDefault,
  WARDEN_LABEL,
} from '../../../daemon/lib/admission.ts';
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
    should(deep?.message).equal('a is 2 levels deep; helpers may nest 2 deep, so it may not start its own.');
    should(shallow?.message).equal('b is 1 level deep; helpers may nest 1 deep, so it may not start its own.');
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
    should(full?.message).equal('u already has 4 running helpers, the most an unattended ferret may have (4).');
    should(fullInteractive?.message).equal(
      'i already has 20 running helpers, the most an interactive ferret may have (20).',
    );
  });

  it('should say "helper" in the singular when the limit is one', () => {
    // Arrange
    const parent = { id: 'p', interactive: false, depth: 0, runningChildren: 1 };

    // Act
    const refusal = admitChild(parent, { ...LIMITS, autoChildren: 1 });

    // Assert
    should(refusal?.message).equal('p already has 1 running helper, the most an unattended ferret may have (1).');
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

describe('packLaunchDefault', () => {
  it('should tell a ferret its record says is on, and never a miner, a warden, a switched-off one or one too deep', () => {
    // Arrange — a ferret started before Pack mode: no stored FY_PACK, no `config.pack`.
    const on = packConfig();
    const top = { eligible: true, ownSwitch: undefined, depth: 0 };

    // Act
    const told = packLaunchDefault(on, top);
    const miner = packLaunchDefault(on, { ...top, eligible: false });
    const switchedOff = packLaunchDefault(on, { ...top, ownSwitch: false });
    const deepest = packLaunchDefault(on, { ...top, depth: on.limits.maxDepth });
    const machineOff = packLaunchDefault({ ...on, enabled: false }, top);

    // Assert
    should(told).equal('1');
    should([miner, switchedOff, deepest, machineOff]).deepEqual(['0', '0', '0', '0']);
  });
});

describe('packEligibleInLineage', () => {
  const chain = (ferrets: Record<string, PackLineageFacts>) => async (id: string) => ferrets[id];

  it('should refuse a warden by its own label, and every ferret under one however deep', async () => {
    const read = chain({
      w: { label: ` ${WARDEN_LABEL} ` },
      a: { parent: 'w' },
      b: { parent: 'a' },
      c: { parent: 'b' },
    });
    const told = await Promise.all(['w', 'a', 'b', 'c'].map(async id => await packEligibleInLineage(id, read)));
    should(told).deepEqual([false, false, false, false]);
  });

  it('should still read a provenance stamp as a second guard', async () => {
    const read = chain({ s: { provenance: { wardenLineage: true } }, k: { parent: 's' } });
    should(await packEligibleInLineage('s', read)).be.false();
    should(await packEligibleInLineage('k', read)).be.false();
  });

  it('should tell an ordinary ferret whose lead is gone, as today (unknown ancestry is not descent)', async () => {
    const read = chain({ k: { parent: 'pruned' } });
    should(await packEligibleInLineage('k', read)).be.true();
  });

  it('should end a loop and refuse an unknown ferret or a chain past the ceiling', async () => {
    const loop = chain({ a: { parent: 'b' }, b: { parent: 'a' } });
    should(await packEligibleInLineage('a', loop)).be.true();
    should(await packEligibleInLineage('nobody', loop)).be.false();
    const long: Record<string, PackLineageFacts> = {};
    for (let i = 0; i < 20; i += 1) long[`f${String(i)}`] = { parent: `f${String(i + 1)}` };
    should(await packEligibleInLineage('f0', chain(long), 16)).be.false();
    should(await packEligibleInLineage('f10', chain(long), 16)).be.true();
  });
});

describe('runningChildCount', () => {
  it('should count the parent’s children that are not stopped, starting ones included', () => {
    // Arrange
    const children = [
      { parent: 'p', state: 'working' },
      { parent: 'p', state: 'starting' },
      { parent: 'p', state: 'stopped' },
      { parent: 'other', state: 'working' },
      { state: 'working' },
    ];

    // Act + Assert
    should(runningChildCount('p', children)).equal(2);
    should(runningChildCount('nobody', children)).equal(0);
  });
});
