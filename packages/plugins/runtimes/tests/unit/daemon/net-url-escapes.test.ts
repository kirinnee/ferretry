/**
 * CFG-LEAK (ii) fix 4 (G2): a Resolved MCP url whose path holds an escape that does not parse (`%E0%A4%A`, `%zz`, a lone
 * `%`) is shown as written, and is still withheld when the write rule refuses the path. Fake values only.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { resolvedEntries } from '../../../daemon/lib/service/resolved-view.ts';

const GSK = 'gsk_AbCdEfGhIjKlMnOpQrSt12';

const line = (url: string): string => {
  const parsed = parseAccountModel({
    version: 1,
    components: { mcp: { srv: { url } } },
    profiles: { p: { layers: ['mcp/srv'] } },
  });
  const result = resolveProfile({ model: parsed, profile: 'p', harness: 'claude', settingsBodies: {} });
  if (!result.ok) throw new Error('expected a resolution');
  return resolvedEntries(result.resolved).find(entry => entry.field === 'mcp')?.value ?? '';
};

describe('a Resolved url path with a malformed escape', () => {
  for (const path of ['/mcp/%E0%A4%A', '/mcp/%zz', '/mcp/100%']) {
    it(`should show ${path} as written`, () => {
      // Act
      const shown = line(`https://example.com${path}`);

      // Assert
      should(shown).equal(`https://example.com${path}`);
    });
  }

  it('should show no token shape W refuses in the path, though an escape in it does not parse', () => {
    // Act
    const shown = line(`https://example.com/%zz/${GSK}`);

    // Assert
    should(shown).not.containEql(GSK);
  });
});
