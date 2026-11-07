/**
 * The published fleet, never read half-published.
 *
 * The claims: a start that lands while an apply has the manifest moved aside is judged against the
 * fleet the apply leaves, so its missing credential still refuses it; applies wait for reads already
 * in progress and hold back new ones; and neither a failed read nor a failed apply leaves the gate
 * shut.
 *
 * Every "apply" here is held open by a latch the test releases, so each interleaving is chosen rather
 * than hoped for.
 *
 * NO REAL CREDENTIAL APPEARS HERE. Every "value" is a fixture string.
 */
import { describe, it } from 'bun:test';
import { MissingFleetSecretsError, type RuntimeIds } from '@ferretry/fleet';
import should from 'should';
import type { CoreAccount } from '../../../src/lib/core/inventory.ts';
import { FleetLaunchEnvironment } from '../../../src/lib/fleet/launch-environment.ts';
import { FleetPublication, PublishedFleetInventory } from '../../../src/lib/fleet/publication.ts';

const WRAPPER = '/state/fleet/bin/claude-auto-profiled';

const profiled: CoreAccount = {
  id: '00000000-0000-4000-8000-0000000000f1',
  agent: 'claude-auto-profiled',
  kind: 'claude',
  mode: 'auto',
  wrapper: WRAPPER,
  home: '/state/fleet/homes/auto-profiled',
  displayName: 'Profiled',
  defaultModel: 'model-one',
  models: [{ id: 'model-one', available: true }],
  available: true,
  unavailableReason: null,
  secretEnv: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' },
};

const IDS = { version: 1, runtimes: {} } as unknown as RuntimeIds;

/** A promise the test resolves when it chooses. */
function latch(): { readonly opened: Promise<void>; open(): void } {
  let open = (): void => {};
  const opened = new Promise<void>(resolve => {
    open = resolve;
  });
  return { opened, open };
}

/** Lets every microtask and timer already queued run, so "still waiting" is an observation. */
const settle = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 5));

/**
 * The manifest file as an apply leaves it: present, then MOVED ASIDE while the apply runs, then the
 * replacement. `accounts` answers exactly what the manifest adapter answers — an absent file is an
 * empty fleet — so the gap is the one the production reader would see.
 */
function manifestOnDisk(): {
  readonly inventory: { accounts(): Promise<readonly CoreAccount[]>; ids(): Promise<RuntimeIds | undefined> };
  /** The mutation an apply runs: what the provisioner does once it holds its claim. */
  readonly mutate: () => Promise<void>;
  readonly movedAside: Promise<void>;
  readonly release: () => void;
} {
  let present = true;
  const aside = latch();
  const hold = latch();
  return {
    inventory: {
      accounts: async () => (present ? [profiled] : []),
      ids: async () => (present ? IDS : undefined),
    },
    mutate: async () => {
      present = false;
      aside.open();
      await hold.opened;
      present = true;
    },
    movedAside: aside.opened,
    release: hold.open,
  };
}

describe('a start during a fleet apply', () => {
  it('should read the gap as no account at all when nothing keeps it out, which is the defect', async () => {
    // Arrange — the reader the daemon had: straight through to the file.
    const disk = manifestOnDisk();
    const subject = new FleetLaunchEnvironment(disk.inventory, { values: async () => new Map() });
    const applying = disk.mutate();
    await disk.movedAside;

    // Act
    const actual = await subject.forWrapper(WRAPPER);
    disk.release();
    await applying;

    // Assert — no account, so no environment and no refusal: the launch would have gone ahead.
    should(actual).deepEqual({});
  });

  it('should refuse the start that needs a missing credential, judged against the fleet the apply leaves', async () => {
    // Arrange
    const disk = manifestOnDisk();
    const publication = new FleetPublication();
    const subject = new FleetLaunchEnvironment(new PublishedFleetInventory(disk.inventory, publication), {
      values: async () => new Map(),
    });
    const applying = publication.publishing(disk.mutate);
    await disk.movedAside;

    // Act
    let outcome: unknown = 'pending';
    const judged = subject.forWrapper(WRAPPER).then(
      environment => (outcome = environment),
      (error: unknown) => (outcome = error),
    );
    await settle();
    const whileApplying = outcome;
    disk.release();
    await applying;
    await judged;

    // Assert — it waited out the gap rather than reading it, then refused naming the secret.
    should(whileApplying).equal('pending');
    should(outcome).be.instanceOf(MissingFleetSecretsError);
    should((outcome as MissingFleetSecretsError).names).deepEqual(['WORK_KEY']);
  });

  it('should keep the runtime names out of the gap too, since the same apply moves them aside', async () => {
    // Arrange
    const disk = manifestOnDisk();
    const publication = new FleetPublication();
    const inventory = new PublishedFleetInventory(disk.inventory, publication);
    const applying = publication.publishing(disk.mutate);
    await disk.movedAside;

    // Act
    const names = inventory.ids();
    await settle();
    disk.release();
    await applying;

    // Assert
    should(await names).equal(IDS);
  });
});

describe('FleetPublication', () => {
  it('should let reads run beside one another', async () => {
    // Arrange
    const publication = new FleetPublication();
    const first = latch();
    let secondRan = false;

    // Act
    const one = publication.reading(async () => await first.opened);
    await publication.reading(async () => {
      secondRan = true;
    });
    first.open();
    await one;

    // Assert — the second finished while the first was still open.
    should(secondRan).be.true();
  });

  it('should start an apply only once the reads already in progress have finished', async () => {
    // Arrange
    const publication = new FleetPublication();
    const reads = [latch(), latch()];
    const order: string[] = [];
    const running = reads.map((read, index) =>
      publication.reading(async () => {
        await read.opened;
        order.push(`read ${index}`);
      }),
    );

    // Act
    const applied = publication.publishing(async () => {
      order.push('apply');
      return 'applied';
    });
    await settle();
    reads[0]?.open();
    await settle();
    const afterOne = [...order];
    reads[1]?.open();
    await Promise.all(running);

    // Assert
    should(afterOne).deepEqual(['read 0']);
    should(await applied).equal('applied');
    should(order).deepEqual(['read 0', 'read 1', 'apply']);
  });

  it('should hold back a read that arrives while an apply waits, so a busy daemon cannot starve it', async () => {
    // Arrange — a read in progress, and an apply queued behind it.
    const publication = new FleetPublication();
    const inProgress = latch();
    const order: string[] = [];
    const first = publication.reading(async () => {
      await inProgress.opened;
      order.push('first read');
    });
    const applied = publication.publishing(async () => {
      order.push('apply');
    });

    // Act
    const late = publication.reading(async () => {
      order.push('late read');
    });
    await settle();
    inProgress.open();
    await Promise.all([first, applied, late]);

    // Assert
    should(order).deepEqual(['first read', 'apply', 'late read']);
  });

  it('should keep a read waiting until every queued apply is done, not just the first', async () => {
    // Arrange
    const publication = new FleetPublication();
    const holds = [latch(), latch()];
    const order: string[] = [];
    const applies = holds.map((hold, index) =>
      publication.publishing(async () => {
        await hold.opened;
        order.push(`apply ${index}`);
      }),
    );
    const read = publication.reading(async () => {
      order.push('read');
    });

    // Act
    holds[0]?.open();
    await applies[0];
    await settle();
    const betweenApplies = [...order];
    holds[1]?.open();
    await Promise.all([...applies, read]);

    // Assert
    should(betweenApplies).deepEqual(['apply 0']);
    should(order).deepEqual(['apply 0', 'apply 1', 'read']);
  });

  it('should open the gate again after an apply that fails, and report its failure', async () => {
    // Arrange
    const publication = new FleetPublication();

    // Act
    const failed = await publication
      .publishing(async () => {
        throw new Error('the apply was refused');
      })
      .catch((error: unknown) => error);
    const read = await publication.reading(async () => 'read');

    // Assert
    should((failed as Error).message).equal('the apply was refused');
    should(read).equal('read');
  });

  it('should let an apply through after a read that fails, and report its failure', async () => {
    // Arrange
    const publication = new FleetPublication();
    const hold = latch();
    const reading = publication
      .reading(async () => {
        await hold.opened;
        throw new Error('the manifest could not be parsed');
      })
      .catch((error: unknown) => error);
    const applied = publication.publishing(async () => 'applied');

    // Act
    hold.open();

    // Assert
    should(((await reading) as Error).message).equal('the manifest could not be parsed');
    should(await applied).equal('applied');
  });
});
