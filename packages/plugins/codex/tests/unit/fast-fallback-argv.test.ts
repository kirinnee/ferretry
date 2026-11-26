import { expect, test } from 'bun:test';
import { buildCodexLaunchArgv } from '../../daemon/lib/launch.ts';

test('E-266 R2 explicit Fast false from the fallback overrides priority settings in the real argv builder', () => {
  // Ferrets pins the producer in its fast-fallback test; this pins the Codex consumer without crossing private halves.
  const settingsFlags = ['-c', 'service_tier="priority"'];
  const inherited = buildCodexLaunchArgv({ executable: 'codex', settingsFlags });
  expect(inherited).toContain('-cservice_tier="priority"');
  expect(inherited).not.toContain('service_tier="default"');
  for (const resume of [undefined, 'synthetic-conversation']) {
    const actual = buildCodexLaunchArgv({ executable: 'codex', settingsFlags, fast: false, resume });
    expect(actual.filter(arg => arg.includes('service_tier=')).at(-1)).toBe('service_tier="default"');
  }
});
