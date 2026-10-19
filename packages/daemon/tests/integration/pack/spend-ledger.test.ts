import { describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FilePackSpendLedger } from '../../../src/adapters/pack/spend-ledger.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';

async function fixture(today = '2026-10-19') {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-pack-spend-'));
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const path = join(home, 'pack-spend.json');
  const day = { current: today };
  const ledger = new FilePackSpendLedger(new StateFileSystem(paths, () => 'unique-id'), path, () => day.current);
  return { home, path, day, ledger };
}

describe('FilePackSpendLedger', () => {
  it('should read nothing spent when no document exists', async () => {
    // Arrange
    const subject = await fixture();
    try {
      // Act + Assert
      should(await subject.ledger.spent()).equal(0);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it("should read today's spend and add each recorded amount to it", async () => {
    // Arrange
    const subject = await fixture();
    try {
      // Act
      await subject.ledger.record(0.1);
      await subject.ledger.record(0.05);

      // Assert
      should(await subject.ledger.spent()).be.approximately(0.15, 1e-9);
      should(JSON.parse(await readFile(subject.path, 'utf8'))).have.property('day', '2026-10-19');
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should read a document from another day as nothing spent, and start the new day from zero', async () => {
    // Arrange
    const subject = await fixture();
    try {
      await writeFile(subject.path, `${JSON.stringify({ day: '2026-10-18', usd: 9 })}\n`);

      // Act + Assert
      should(await subject.ledger.spent()).equal(0);
      await subject.ledger.record(0.2);
      should(JSON.parse(await readFile(subject.path, 'utf8'))).eql({ day: '2026-10-19', usd: 0.2 });
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should read an unparseable document as the cap already reached', async () => {
    // Arrange
    const subject = await fixture();
    try {
      await writeFile(subject.path, '{not json');

      // Act + Assert
      should(await subject.ledger.spent()).equal(Number.POSITIVE_INFINITY);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should read a document of the wrong shape as the cap already reached', async () => {
    // Arrange
    const subject = await fixture();
    try {
      for (const body of [{ day: 1, usd: 1 }, { day: '2026-10-19', usd: '1' }, { day: '2026-10-19' }]) {
        await writeFile(subject.path, JSON.stringify(body));

        // Act + Assert
        should(await subject.ledger.spent()).equal(Number.POSITIVE_INFINITY);
      }
      await writeFile(subject.path, '{"day":"2026-10-19","usd":1e999}');
      should(await subject.ledger.spent()).equal(Number.POSITIVE_INFINITY);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should restart a corrupt ledger from zero on the next record rather than keep it at infinity', async () => {
    // Arrange
    const subject = await fixture();
    try {
      await writeFile(subject.path, '{not json');

      // Act
      await subject.ledger.record(0.3);

      // Assert
      should(await subject.ledger.spent()).equal(0.3);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should ignore a negative amount', async () => {
    // Arrange
    const subject = await fixture();
    try {
      await subject.ledger.record(0.4);

      // Act
      await subject.ledger.record(-5);

      // Assert
      should(await subject.ledger.spent()).equal(0.4);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });
});
