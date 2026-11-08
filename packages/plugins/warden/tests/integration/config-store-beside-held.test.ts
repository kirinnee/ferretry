/**
 * The owner's section save beside a held edit of `warden.yaml`, through the kernel's real config writer
 * (docs/config-files.md rule 3): the 2026-10-29 price-incident shape. A hand-made correction of the Jev price waits for
 * the owner; the owner then saves a guard threshold from the app. The save is in effect at once, the held version keeps
 * its own price, and that edit stays held: a save neither discards a held edit nor puts one into effect.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { Log } from '@ferretry/kernel/contract';
import { config, state } from '@ferretry/kernel/host';
import { fixedClock } from '@ferretry/kernel/testing';
import { effectiveWardenConfig, WARDEN_CONFIG, type WardenFile } from '../../contract/index.ts';
import { ConfigWardenConfigStore, WardenConfigHeld } from '../../daemon/adapters/config-store.ts';
import type { WardenConfigPatch } from '../../daemon/lib/index.ts';

const HOME = '/home/fy';
const PATH = `${HOME}/config/warden.yaml`;
const IN_EFFECT = '# the owner’s guard\nguard:\n  threshold: 0.7\n  usdPerMillionInputTokens: 2 # per million\n';
/** The correction made by hand: a lower price spends sooner, so it loosens and waits for the owner. */
const HELD_PRICE = '# the owner’s guard\nguard:\n  threshold: 0.7\n  usdPerMillionInputTokens: 0.042 # per million\n';

const quiet: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
} as unknown as Log;

async function heldPrice() {
  const fs = state.createMemoryHostFs();
  const files = config.createConfigFiles({
    home: HOME,
    fs,
    clock: fixedClock('2026-11-08T09:00:00.000Z'),
    log: quiet,
    binary: 'fy',
    defs: [{ plugin: 'warden', def: WARDEN_CONFIG }],
    // Gate's judge never lets a plugin's own loosening into effect here: only the owner confirms one.
    judge: () => false,
  });
  await files.reload();
  const port = files.port('warden');
  should((await port.write(WARDEN_CONFIG, undefined, IN_EFFECT)).kind).equal('written');
  fs.seed(PATH, HELD_PRICE);
  await files.reload();
  should(port.fileState(WARDEN_CONFIG).state).equal('held');
  return { port, disk: () => String(fs.snapshot().get(PATH)) };
}

describe('an owner’s section save beside a held edit of warden.yaml, through the real kernel writer', () => {
  it('should put the saved sub-key into effect, keep the held version’s own price, and keep that edit held', async () => {
    // Arrange: price 2 in effect, the 0.042 correction held; the owner raises the guard threshold (a tightening).
    const { port, disk } = await heldPrice();
    const store = new ConfigWardenConfigStore(port);
    const inEffect = effectiveWardenConfig(port.file(WARDEN_CONFIG) ?? {});
    const next = { ...inEffect, guard: { ...inEffect.guard, threshold: 0.8 } };

    // Act: the app sends only the sub-key that changed.
    const waiting = await store.write(next, { guard: { threshold: 0.8 } } as WardenConfigPatch);

    // Assert: in effect at once, the price in effect untouched; the file keeps the held price, still held.
    should(waiting).eql([]);
    const guard = (port.file(WARDEN_CONFIG) as WardenFile).guard;
    should(guard?.threshold).equal(0.8);
    should(guard?.usdPerMillionInputTokens).equal(2);
    should(disk()).match(/threshold: 0\.8/);
    should(disk()).match(/usdPerMillionInputTokens: 0\.042 # per million/);
    should(port.fileState(WARDEN_CONFIG)).eql({
      state: 'held',
      inEffect: true,
      sentences: ['the Jev price the cap counts with goes down from 2 to 0.042'],
    });
  });

  it('should hold a section save that loosens beside a held edit: not in effect, the held price kept, both on disk', async () => {
    // Arrange: price 2 in effect, the 0.042 correction held; the owner raises a cap (a loosening the judge refuses).
    const { port, disk } = await heldPrice();
    const store = new ConfigWardenConfigStore(port);
    const inEffect = effectiveWardenConfig(port.file(WARDEN_CONFIG) ?? {});
    const next = { ...inEffect, caps: { ...inEffect.caps, jevUsdPerDay: 5 } };

    // Act
    const waiting = await store.write(next, { caps: { jevUsdPerDay: 5 } } as WardenConfigPatch);

    // Assert: answered held, the cap and the price in effect unchanged, the file holding both edits.
    should(waiting.length).equal(2);
    should(waiting.some(sentence => sentence.includes('0.042'))).equal(true);
    const file = port.file(WARDEN_CONFIG) as WardenFile;
    should(file.caps).equal(undefined);
    should(file.guard?.usdPerMillionInputTokens).equal(2);
    should(disk()).match(/jevUsdPerDay: 5/);
    should(disk()).match(/usdPerMillionInputTokens: 0\.042 # per million/);
    should(port.fileState(WARDEN_CONFIG).state).equal('held');
  });

  it('should save a top-level key to both versions whole, the held price kept and still held', async () => {
    const { port, disk } = await heldPrice();
    const store = new ConfigWardenConfigStore(port);
    const inEffect = effectiveWardenConfig(port.file(WARDEN_CONFIG) ?? {});

    const waiting = await store.write({ ...inEffect, enabled: false }, { enabled: false } as WardenConfigPatch);

    should(waiting).eql([]);
    should((port.file(WARDEN_CONFIG) as WardenFile).enabled).equal(false);
    should(disk()).match(/enabled: false/);
    should(disk()).match(/usdPerMillionInputTokens: 0\.042 # per million/);
    should(port.fileState(WARDEN_CONFIG).state).equal('held');
  });

  it('should refuse a save that names nothing while an edit is held, writing neither version', async () => {
    const { port, disk } = await heldPrice();
    const store = new ConfigWardenConfigStore(port);
    const before = disk();

    await should(
      store.write(effectiveWardenConfig(port.file(WARDEN_CONFIG) ?? {}), {} as WardenConfigPatch),
    ).be.rejectedWith(WardenConfigHeld);

    should(disk()).equal(before);
    should(port.fileState(WARDEN_CONFIG).state).equal('held');
  });
});
