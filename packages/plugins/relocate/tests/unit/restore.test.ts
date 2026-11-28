import { describe, expect, test } from 'bun:test';
import { NEW_FERRET, targetWorld } from '../support/target.ts';
import { world } from '../support/world.ts';

/**
 * U16: the turns, queued messages and attachments a ferret had arrive in its NEW session folder (through Ferrets, which judges
 * every path), byte for byte. A refusal never undoes the running ferret or its working tree: it says so, and the source has every file.
 */
describe('restoring the session a moved ferret had', () => {
  test('every session file the source listed is handed to Ferrets for the new ferret, byte for byte', async () => {
    const w = await world();
    const sourceFiles = await w.source.files();
    const t = await targetWorld({}, w.fixture.remote);
    const { offerId, header } = await t.carry(w);
    const done = await t.importer.import(offerId, { header, sourceDaemonId: header.sourceDaemonId });

    expect(done.recovery).toBeUndefined();
    const wanted = sourceFiles.filter(file => file.area === 'session');
    expect(wanted.length).toBeGreaterThan(0);
    expect(t.restored.map(file => file.path).sort()).toEqual(wanted.map(file => file.path).sort());
    for (const file of t.restored) {
      expect(file.ferret).toBe(NEW_FERRET);
      const original = await w.source.read({ area: 'session', path: file.path }, 1024 * 1024);
      expect(Buffer.from(file.bytes).equals(Buffer.from(original))).toBe(true);
    }
    // the journal is the source's own record and stays there
    expect(t.restored.some(file => file.path === 'history.jsonl')).toBe(false);
  });

  test('a refused restore leaves the imported ferret stopped and says what did not arrive', async () => {
    const w = await world();
    const t = await targetWorld({ restoreFails: true }, w.fixture.remote);
    const { offerId, header } = await t.carry(w);
    const done = await t.importer.import(offerId, { header, sourceDaemonId: header.sourceDaemonId });

    expect(done.ferretId).toBe(NEW_FERRET);
    expect(done.recovery?.code).toBe('session_unrestored');
    expect(done.recovery?.state).toBe('stopped');
    expect(done.recovery?.message).toContain('not all restored');
    expect(t.stopped).toEqual([]);
    // where it came from is still kept
    expect(t.recorded.get(NEW_FERRET)?.ferretId).toBeDefined();
  });
});
