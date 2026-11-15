import { describe, expect, test } from 'bun:test';
import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { T0 } from '../../../../contract/testing/index.ts';
import { FerretsService } from '../../../../daemon/lib/ferrets/service.ts';
import type { SessionCutOffMark } from '../../../../daemon/lib/tokens/cut-off-mark.ts';
import { KeyedSerialExecutor } from '../../../../daemon/adapters/storage/keyed-serial-executor.ts';
import { additivesFixture } from './additives-fixture.ts';

/**
 * Two things the lifecycle's launch needs from Ferrets' own start, stop, resume and revoke before it may launch a ferret
 * that already exists: they run on the ONE per-ferret queue the whole daemon shares, and an owner's cut-off is ONE fact
 * (the token directory's mark and the session document's `credentialRevoked` are written together and read together).
 * Fakes only: the document's half is a set in memory.
 */

class DocumentMark implements SessionCutOffMark {
  readonly cut = new Set<string>();
  failRestore = false;
  async isCutOff(id: string): Promise<boolean> {
    return this.cut.has(id);
  }
  async cutOff(id: string): Promise<void> {
    this.cut.add(id);
  }
  async restore(id: string): Promise<void> {
    if (this.failRestore) throw new Error('document locked');
    this.cut.delete(id);
  }
}

function withMark(options: Parameters<typeof additivesFixture>[0] = {}) {
  const f = additivesFixture(options);
  const mark = new DocumentMark();
  f.ports.cutOffMark = mark;
  return { ...f, mark };
}

type Fixture = ReturnType<typeof additivesFixture>;

describe('Ferrets runs on the one queue every writer of a ferret shares', () => {
  const actions = {
    revoke: async (f: Fixture) => await f.service.revokeToken(f.id),
    resume: async (f: Fixture) => await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN }),
    start: async (f: Fixture) => await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN),
  } as const;

  test.each([
    ['revoke', { state: 'stopped' }],
    ['resume', { state: 'stopped' }],
    ['start', { empty: true }],
  ] as const)(
    'should hold a %s behind work a lifecycle already holds on that ferret, and run it once that work settles',
    async (name, options) => {
      // Arrange — the shared queue, a lifecycle's launch holding the ferret's key, and a service bound to the queue.
      const shared = new KeyedSerialExecutor();
      const base = additivesFixture(options);
      const f: Fixture = {
        ...base,
        service: new FerretsService(base.registry, base.tokens, { ...base.ports, serial: shared }),
      };
      let release: () => void = () => {};
      const held = shared.run(f.id, async () => await new Promise<void>(resolve => (release = resolve)));

      // Act
      let settled = false;
      const acting = actions[name](f).then(() => {
        settled = true;
      });
      await Bun.sleep(20);
      const earlyStarts = f.runner.starts;
      const earlySettled = settled;
      release();
      await held;
      await acting;

      // Assert
      expect(earlySettled).toBe(false);
      expect(earlyStarts).toBe(0);
      expect(settled).toBe(true);
    },
  );
});

describe('an owner cut-off is one fact across the token directory and the session document', () => {
  test('should write the document mark as well as the directory mark when the owner revokes the credential', async () => {
    // Arrange
    const f = withMark();

    // Act
    await f.service.revokeToken(f.id);

    // Assert
    expect(f.tokens.isCutOff(f.id)).toBe(true);
    expect(f.mark.cut.has(f.id)).toBe(true);
  });

  test('should refuse a launch when only the document says the ferret is cut off', async () => {
    // Arrange — the directory is clean; the document alone carries the mark (the lifecycle's own revoke wrote it)
    const f = withMark();
    f.mark.cut.add(f.id);

    // Act
    const answer = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN });

    // Assert — refused as a cut-off ferret is, nothing launched, the mark untouched
    expect(answer).toEqual({
      ok: false,
      error: { code: 'refused', reason: 'only a confirmed owner resume may restore a cut-off ferret' },
    });
    expect(f.runner.starts).toBe(0);
    expect(f.mark.cut.has(f.id)).toBe(true);
  });

  test('should refuse a live-pane replacement before the pane is given up when only the document says cut off', async () => {
    // Arrange
    const f = withMark({ state: 'working' });
    f.mark.cut.add(f.id);

    // Act
    const answer = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN, replaceLiveTerminal: true });

    // Assert
    expect(answer).toEqual({
      ok: false,
      error: { code: 'refused', reason: 'only a confirmed owner resume may restore a cut-off ferret' },
    });
    expect(f.registry.get(f.id)?.state).toBe('working');
  });

  test('should clear both marks when a confirmed owner resume restores a ferret only the document had cut off', async () => {
    // Arrange
    const f = withMark();
    f.mark.cut.add(f.id);

    // Act
    const answer = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN, confirmRestore: () => {} });

    // Assert
    expect(answer.ok).toBe(true);
    expect(f.mark.cut.has(f.id)).toBe(false);
    expect(f.tokens.isCutOff(f.id)).toBe(false);
    expect(f.runner.starts).toBe(1);
  });

  test('should leave the ferret cut off when the document mark cannot be cleared, and start nothing', async () => {
    // Arrange — both halves cut off, the document refuses to restore
    const f = withMark();
    f.tokens.cutOff(f.id, T0);
    f.mark.cut.add(f.id);
    f.mark.failRestore = true;

    // Act
    const restoring = f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN, confirmRestore: () => {} });

    // Assert — the document is cleared FIRST, so the directory's mark is still there
    await expect(restoring).rejects.toThrow('document locked');
    expect(f.tokens.isCutOff(f.id)).toBe(true);
    expect(f.mark.cut.has(f.id)).toBe(true);
    expect(f.runner.starts).toBe(0);
  });

  test('should write both marks again when a restore cannot save its tokens', async () => {
    // Arrange
    const f = withMark();
    f.tokens.cutOff(f.id, T0);
    f.mark.cut.add(f.id);
    let saves = 0;
    f.ports.saveTokens = async () => {
      saves += 1;
      if (saves === 1) throw new Error('disk full');
    };

    // Act
    const restoring = f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN, confirmRestore: () => {} });

    // Assert
    await expect(restoring).rejects.toThrow('disk full');
    expect(f.tokens.isCutOff(f.id)).toBe(true);
    expect(f.mark.cut.has(f.id)).toBe(true);
    expect(f.runner.starts).toBe(0);
  });

  test('should cut both marks again when the resume that followed a restore is refused', async () => {
    // Arrange — a cut-off ferret whose harness is switched off, so the restored resume is refused
    const f = withMark();
    f.mark.cut.add(f.id);
    f.ports.harness = () => undefined;

    // Act
    const answer = await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN, confirmRestore: () => {} });

    // Assert
    expect(answer.ok).toBe(false);
    expect(f.tokens.isCutOff(f.id)).toBe(true);
    expect(f.mark.cut.has(f.id)).toBe(true);
    expect(f.runner.starts).toBe(0);
  });
});
