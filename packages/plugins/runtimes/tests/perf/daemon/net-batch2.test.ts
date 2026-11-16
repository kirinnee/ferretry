/**
 * CFG-LEAK (ii) batch 2: the one value rule (`valueWithheld`) and the views built on it stay linear to 256 KiB. What
 * they withhold is tests/unit/daemon/net-batch2.test.ts; this file holds only the time. Fake values only.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { ratioOf } from '@ferretry/std/testing/linear-time';
import { valueWithheld } from '../../../daemon/lib/service/command-line.ts';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { resolvedEntries } from '../../../daemon/lib/service/resolved-view.ts';

const model = (components: Record<string, unknown>, profiles: Record<string, unknown> = {}, extra = {}) =>
  parseAccountModel({ version: 1, components, profiles, ...extra });

describe('the batch 2 nets stay linear to 256 KiB', () => {
  const shapes: Readonly<Record<string, (size: number) => () => void>> = {
    'one long settings value': size => () => valueWithheld('x', 'ab1X'.repeat(size / 4)),
    'a long list of settings words': size => () =>
      valueWithheld(
        'x',
        Array.from({ length: size / 8 }, () => 'ab1X-yz9'),
      ),
    'a long list of arguments': size => () => {
      const parsed = model(
        { mcp: { srv: { command: 'srv', args: Array.from({ length: size / 8 }, () => 'ab1X-yz9') } } },
        { p: { layers: ['mcp/srv'] } },
      );
      const resolved = resolveProfile({ model: parsed, profile: 'p', harness: 'claude', settingsBodies: {} });
      if (resolved.ok) resolvedEntries(resolved.resolved);
    },
    'a long url path': size => () => {
      const parsed = model(
        { mcp: { srv: { url: `https://h.example/${'a1B2/'.repeat(size / 5)}` } } },
        { p: { layers: ['mcp/srv'] } },
      );
      const resolved = resolveProfile({ model: parsed, profile: 'p', harness: 'claude', settingsBodies: {} });
      if (resolved.ok) resolvedEntries(resolved.resolved);
    },
  };
  for (const [name, make] of Object.entries(shapes)) {
    it(`should grow under 3x from 128 to 256 KiB: ${name}`, () => {
      const ratio = ratioOf(make(256 * 1024), make(128 * 1024));
      should(ratio).be.below(3);
    }, 60_000);
  }
});
