import { describe, expect, test } from 'bun:test';
import { DEFAULT_GATE_CONFIG } from '../../../contract/index.ts';
import { aliasBomb, seeded, boot, CAP, origins, realConfig } from '../../support/build-world.ts';

/** G155, the SPEED and SIZE half: booting over the alias bomb takes under 1.5 s and under 1 GiB. The refusal is unit's. */
describe('grant provenance is read by the kernel, never by a parse of its own', () => {
  test('G155 the alias-bomb shape (one long string aliased to the cap): boot is quick and bounded', async () => {
    const bomb = aliasBomb();
    expect(bomb.length).toBeLessThanOrEqual(CAP);
    const files = await realConfig(bomb);
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    const built = boot({ secrets: seeded, config: DEFAULT_GATE_CONFIG, writer: files.writer() });
    await built.jobs.get('gate.tokens')?.();
    await origins(built, map => map.get('fleet') === 'config file');
    const took = performance.now() - started;
    // `Bun.YAML.parse` of that text took 2.3 s and 5.4 GB; the kernel's read refuses it in one linear pass.
    expect(took).toBeLessThan(1_500);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(1024 * 1024 * 1024);
  });
});
