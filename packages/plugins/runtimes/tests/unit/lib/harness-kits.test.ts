/**
 * What each harness's own plugin hands Runtimes (`RuntimesHarnessKit`) is read from the harness's settings source and
 * nowhere else: a harness whose plugin is off, or whose source gives no kit, has no entry, and no other harness's kit
 * ever stands in for it.
 */
import { describe, expect, it } from 'bun:test';
import {
  type ProfileComponentSource,
  ProfileClaudeSettingsSource,
  ProfileCodexSettingsSource,
  type RuntimesHarnessKit,
} from '../../../contract/index.ts';
import { harnessKits } from '../../../daemon/adapters/profile-components.ts';

const source = (kit?: RuntimesHarnessKit): ProfileComponentSource => ({
  list: async () => [],
  read: async () => undefined,
  ...(kit === undefined ? {} : { kit }),
});

describe('harnessKits', () => {
  it('reads each harness kit from that harness settings source', () => {
    const claude: RuntimesHarnessKit = { command: 'claude' };
    const codex: RuntimesHarnessKit = { command: 'codex' };
    const kits = harnessKits(hook => (hook === ProfileClaudeSettingsSource ? source(claude) : source(codex)));
    expect(kits.get('claude')).toBe(claude);
    expect(kits.get('codex')).toBe(codex);
  });

  it('has no entry for a harness whose plugin is off or gives no kit', () => {
    const codex: RuntimesHarnessKit = { command: 'codex' };
    const kits = harnessKits(hook => (hook === ProfileCodexSettingsSource ? source(codex) : 'unavailable'));
    expect([...kits.keys()]).toEqual(['codex']);
    expect([...harnessKits(() => source()).keys()]).toEqual([]);
  });
});
