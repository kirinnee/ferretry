import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FileRoutingCatalog } from '../../../src/adapters/core/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';

const document = {
  models: [
    {
      id: 'apex',
      label: 'Apex',
      family: 'claude',
      tier: 'frontier planner',
      speed: 'slow',
      cost: 'very-high',
      power: 100,
      roleScore: { planner: 100 },
      implementerFit: { mechanical: 5, mid: 40, hard: 78 },
      note: 'maps blindspots before code exists',
    },
  ],
  accounts: [{ accountId: 'account-primary', options: [{ model: 'apex' }] }],
  floors: { planner: 88, reviewer: 70, hardAndDemanding: 96, hardOrCritical: 88, mid: 40, qualityFirst: 88 },
  costPenalty: { balanced: { 'very-high': 8 } },
};

async function fixture(contents?: string): Promise<{ readonly home: string; readonly routing: FileRoutingCatalog }> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-routing-'));
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  if (contents !== undefined) {
    await mkdir(dirname(paths.routingCatalog), { recursive: true });
    await writeFile(paths.routingCatalog, contents, 'utf8');
  }
  return { home, routing: new FileRoutingCatalog(new StateFileSystem(paths), paths.routingCatalog) };
}

describe('FileRoutingCatalog', () => {
  it("should read the operator's routing doctrine", async () => {
    // Arrange
    const subject = await fixture(JSON.stringify(document));
    try {
      // Act
      const catalog = await subject.routing.catalog();

      // Assert
      should(catalog.models.map(model => model.id)).eql(['apex']);
      should(catalog.floors.planner).equal(88);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should refuse to invent a catalog when the operator has written none', async () => {
    // Arrange — a default here would be the fourth hardcoded fleet table this port exists to delete
    const subject = await fixture();
    try {
      // Act / Assert
      await should(subject.routing.catalog()).be.rejectedWith(/no routing catalog at .*routing\.json/);
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });

  it('should refuse a catalog whose cross-references do not hold', async () => {
    // Arrange — an account offering a model the catalog never declares
    const broken = { ...document, accounts: [{ accountId: 'account-primary', options: [{ model: 'ghost' }] }] };
    const subject = await fixture(JSON.stringify(broken));
    try {
      // Act / Assert
      await should(subject.routing.catalog()).be.rejected();
    } finally {
      await rm(subject.home, { recursive: true, force: true });
    }
  });
});
