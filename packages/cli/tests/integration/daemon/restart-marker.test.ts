import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileDaemonRestartMarker, restartMarkerPath } from '../../../src/adapters/daemon/restart-marker.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-restart-marker-'));
  roots.push(root);
  return root;
}

describe('the restart marker', () => {
  it('should vouch for a restart until its instant, privately, and not after it is cleared', async () => {
    // Arrange
    const path = restartMarkerPath(await home());
    const marker = new FileDaemonRestartMarker(path);

    // Act
    await marker.mark(10_000.7);
    const during = await marker.active(9_999);
    const after = await marker.active(10_000);
    const mode = (await stat(path)).mode & 0o777;
    const text = await readFile(path, 'utf8');
    await marker.clear();
    const cleared = await marker.active(0);

    // Assert
    should(path.endsWith('/restarting.json')).be.true();
    should(during).be.true();
    should(after).be.false();
    should(mode).equal(0o600);
    should(text).equal('{"until":10000}\n');
    should(cleared).be.false();
  });

  it('should read a missing, damaged or foreign marker as no restart, and never throw', async () => {
    // Arrange
    const root = await home();
    const damaged = join(root, 'damaged.json');
    const foreign = join(root, 'foreign.json');
    await writeFile(damaged, '{"until":');
    await writeFile(foreign, '{"until":"soon"}');
    const nowhere = new FileDaemonRestartMarker(join(root, 'no-such-dir', 'restarting.json'));

    // Act
    const missing = await nowhere.active(0);
    const torn = await new FileDaemonRestartMarker(damaged).active(0);
    const wrong = await new FileDaemonRestartMarker(foreign).active(0);
    await nowhere.mark(1_000);
    await nowhere.clear();

    // Assert
    should([missing, torn, wrong]).deepEqual([false, false, false]);
  });
});
