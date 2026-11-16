/**
 * CFG-LEAK (ii) fix 4 (G2): a Resolved MCP url whose path holds an escape that does not parse (`%E0%A4%A`, `%zz`, a lone
 * `%`) is shown as written, and a token shape in the path is still withheld. Fake values only.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { resolvedEntries } from '../../../daemon/lib/service/resolved-view.ts';
import { WITHHELD_WORDS_TEXT as WITHHELD } from '../../../contract/index.ts';

const GSK = 'gsk_AbCdEfGhIjKlMnOpQrSt12';
const V = 'Zk3pQ9vXw2LmN7rT';

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

describe('a Resolved url path with a malformed escape AND a refused flag value in the same path', () => {
  for (const bad of ['%zz', '%E0%A4%A', '%']) {
    it(`should withhold https://h/${bad}/mcp --token <value>, the valid escapes read though ${bad} does not parse`, () => {
      // Act
      const shown = line(`https://h.example/${bad}/mcp --token ${V}`);

      // Assert
      should(shown).not.containEql(V);
      should(shown).equal(WITHHELD);
    });
  }

  it('should read the ASCII escapes of a run that does not parse as a whole (%20 then half a character)', () => {
    // Act
    const shown = line(`https://h.example/mcp%20--token%20${V}%20%E0%A4`);

    // Assert
    should(shown).equal(WITHHELD);
  });

  it('should still show a path that has a malformed escape and nothing refused beside it', () => {
    should(line('https://h.example/%zz/mcp%20v2')).equal('https://h.example/%zz/mcp%20v2');
  });
});
