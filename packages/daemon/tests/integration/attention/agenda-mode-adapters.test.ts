import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENDA_ENV } from '@ferretry/fleet';
import should from 'should';
import { FileAgendaMigrationMarker } from '../../../src/adapters/attention/file-agenda-migration-marker.ts';
import { EnvironmentAgendaModes } from '../../../src/adapters/attention/session-agenda-modes.ts';
import { FileSessionEnvironmentStore } from '../../../src/adapters/session/lifecycle/file-session-environment-store.ts';
import { parseSessionId } from '../../../src/lib/index.ts';

/** Agenda mode as it is kept on disk: a flag in the launch environment, and the one-time migration's record. */

const homes = new Set<string>();
const ID = parseSessionId('session-1');

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-agenda-'));
  homes.add(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of homes) await rm(directory, { recursive: true, force: true });
  homes.clear();
});

describe('EnvironmentAgendaModes', () => {
  it('should be on only when the launch environment says so', async () => {
    // Arrange
    const root = await home();
    const store = new FileSessionEnvironmentStore(id => join(root, id));
    const modes = new EnvironmentAgendaModes(store);

    // Act
    const unset = await modes.enabled('session-1');
    await store.write(ID, { [AGENDA_ENV]: '1' });
    const on = await modes.enabled('session-1');
    await store.write(ID, { [AGENDA_ENV]: '0' });
    const off = await modes.enabled('session-1');

    // Assert
    should([unset, on, off]).deepEqual([false, true, false]);
  });

  it('should be off for a session id the layout refuses', async () => {
    // Arrange
    const root = await home();
    const modes = new EnvironmentAgendaModes(new FileSessionEnvironmentStore(id => join(root, id)));

    // Act + Assert
    should(await modes.enabled('../escape')).be.false();
  });
});

describe('FileAgendaMigrationMarker', () => {
  it('should be unrecorded until recorded, then say it ran, in an owner-only document', async () => {
    // Arrange
    const root = await home();
    const file = join(root, 'nested', 'agenda-mode-migration.json');
    const marker = new FileAgendaMigrationMarker(file);

    // Act
    const before = await marker.ran();
    await marker.record('2026-10-23T10:00:00.000Z', ['session-1']);
    const after = await marker.ran();
    const document = JSON.parse(await readFile(file, 'utf8')) as unknown;

    // Assert
    should(before).be.false();
    should(after).be.true();
    should(document).deepEqual({ v: 1, ranAt: '2026-10-23T10:00:00.000Z', switchedOn: ['session-1'] });
  });
});
