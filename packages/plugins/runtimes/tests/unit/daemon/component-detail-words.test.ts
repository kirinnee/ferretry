/**
 * A component's launch flags and MCP arguments in its detail (`GET /v1/runtimes/components`, R-0082), rulings #39 and
 * #40: 4.291.5 served them RAW to every `fleet.use` caller (a ferret, a `--limited` device) because the edit form
 * round-tripped them. 5.0 cuts a credential out of each word with the ONE command-line rule the Resolved view follows,
 * for every caller, and the form keeps a hidden word by its position instead (`component-words-keep.test.ts`).
 *
 * Every secret here is an obviously fake one.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { CommandWord, ComponentDetail } from '../../../contract/index.ts';
import { type CatalogFacts, componentCatalog } from '../../../daemon/lib/service/catalog.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { resolvedEntries } from '../../../daemon/lib/service/resolved-view.ts';
import { shownWords } from '@ferretry/core-vault/contract';
import { shownWordsEtag } from '../../../daemon/lib/service/shown-words-etag.ts';
import { HIDDEN, nestedBreach, nestedFamily } from './command-line-family.ts';

const FAKE_SECRET = 'not-a-real-secret-0000';
const FAKE_TOKEN = 'sk-not-a-real-key-0000';
const FAKE_GH = 'ghp_notarealtoken0000';

const FACTS: CatalogFacts = {
  format: 'present',
  machineName: 'studio',
  tools: { claude: '/usr/bin/claude', codex: undefined },
  runningSessions: 0,
  userHome: '/home/person',
  acceptsAutoPermissionMode: true,
};

const modelWith = (components: Record<string, unknown>) =>
  parseAccountModel({ version: 1, components, profiles: { p: { layers: [] } } });

/** The detail of the one component `kind/name` in the catalogue of a model holding only `components`. */
function detailOf(components: Record<string, unknown>, kind: string, name: string): ComponentDetail {
  const found = componentCatalog(modelWith(components), FACTS)
    .kinds.flatMap(group => group.components)
    .find(component => component.reference === `${kind}/${name}`);
  if (found === undefined) throw new Error(`no ${kind}/${name}`);
  return found.detail;
}

const flagsOf = (flags: readonly string[]): readonly CommandWord[] => {
  const detail = detailOf({ settings: { base: { harness: 'claude', flags: [...flags] } } }, 'settings', 'base');
  return detail.kind === 'settings' ? (detail.flags ?? []) : [];
};

const argsOf = (args: readonly string[], command = 'run-server'): readonly CommandWord[] => {
  const detail = detailOf({ mcp: { local: { command, args: [...args] } } }, 'mcp', 'local');
  return detail.kind === 'mcp' ? (detail.args ?? []) : [];
};

const hid = (shown: string): CommandWord => ({ shown, hidden: true });

/** A detail's words as the Resolved view's `{ value, hidden }` pairs, for the shared family checks. */
const asShown = (words: readonly CommandWord[]) =>
  words.map(word => (typeof word === 'string' ? { value: word } : { value: word.shown, hidden: true as const }));

describe('componentDetail — a credential in a launch flag or MCP argument (R-0082, ruling #39)', () => {
  it('R-0082 should hide the value of a secret-named flag in every #37 form and keep the flag: --flag=v, --flag v, -k=v', () => {
    // Act
    const actual = flagsOf([
      `--token=${FAKE_SECRET}`,
      '--api-key',
      FAKE_SECRET,
      `--token ${FAKE_SECRET}`,
      `-k=${FAKE_TOKEN}`,
      `-token=${FAKE_SECRET}`,
      '--verbose',
    ]);

    // Assert
    should(actual).deepEqual([
      hid(`--token=${HIDDEN}`),
      '--api-key',
      hid(HIDDEN),
      hid(`--token ${HIDDEN}`),
      hid(`-k=${HIDDEN}`),
      hid(`-token=${HIDDEN}`),
      '--verbose',
    ]);
  });

  it('R-0082 should hide a token under a harmless flag, stuck to a one-letter flag, and quoted: --header=Bearer <token>, -H<token>', () => {
    // Act
    const actual = flagsOf([
      `--header=Bearer ${FAKE_GH}`,
      `-H${FAKE_TOKEN}`,
      `"${FAKE_TOKEN}"`,
      `--password '${FAKE_SECRET}'`,
    ]);

    // Assert
    should(actual).deepEqual([hid(`--header=${HIDDEN}`), hid(`-H${HIDDEN}`), hid(HIDDEN), hid(`--password ${HIDDEN}`)]);
  });

  it("R-0082 should hide the same shapes in an MCP server's arguments, judging the first by the command before it", () => {
    // Act
    const actual = argsOf(['--token', FAKE_SECRET, `--header=Bearer ${FAKE_GH}`, `-k=${FAKE_TOKEN}`, '--plain', 'x']);

    // Assert
    should(actual).deepEqual(['--token', hid(HIDDEN), hid(`--header=${HIDDEN}`), hid(`-k=${HIDDEN}`), '--plain', 'x']);
    should(argsOf([FAKE_SECRET], '--token')).deepEqual([hid(HIDDEN)]);
  });

  it('R-0082 should keep a pointer, a short value and a harmless flag as written (control)', () => {
    // Arrange
    const words = [
      '--token=$API_TOKEN',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
      '--api-key=${secret:API_KEY}',
      '--auth=1',
      '--model',
      'claude-opus-5-5',
      '--tokens-per-minute=5000000000',
      '',
    ];

    // Assert
    should(flagsOf(words.filter(word => word !== ''))).deepEqual(words.filter(word => word !== ''));
    should(argsOf(words)).deepEqual(words);
  });

  it('R-0082 should send the etag of the words as shown with them, so it carries nothing the read does not show', () => {
    // Arrange
    const flags = ['--token', FAKE_SECRET];
    const detail = detailOf({ settings: { base: { harness: 'claude', flags } } }, 'settings', 'base');
    const other = detailOf(
      { settings: { base: { harness: 'claude', flags: ['--token', 'another-fake-secret-0000'] } } },
      'settings',
      'base',
    );
    const mcp = detailOf({ mcp: { local: { command: 'srv', args: ['a'] } } }, 'mcp', 'local');

    // Assert — the same shown words give the same etag, whatever the hidden value is.
    should(detail.kind === 'settings' && detail.flagsEtag).equal(shownWordsEtag(shownWords(flags)));
    should(other.kind === 'settings' && other.flagsEtag).equal(detail.kind === 'settings' && detail.flagsEtag);
    should(JSON.stringify(detail)).not.containEql(FAKE_SECRET);
    should(mcp.kind === 'mcp' && mcp.argsEtag).equal(shownWordsEtag(shownWords(['a'], 'srv')));
    should(detailOf({ mcp: { u: { url: 'https://h.example.invalid' } } }, 'mcp', 'u')).not.have.property('argsEtag');
    should(
      detailOf({ settings: { s: { harness: 'claude', file: 'components/settings/s.json' } } }, 'settings', 's'),
    ).not.have.property('flagsEtag');
  });
});

describe('componentDetail — a credential nested inside a value (R-0082, ruling #40)', () => {
  it('R-0082 should hide a nested secret-named key and a URL password, keeping the key, the user, the host and the other parameters', () => {
    // Act
    const actual = argsOf([
      '-c',
      `mcp_servers.x.env.API_KEY=${FAKE_SECRET}`,
      `--header=Authorization: Bearer ${FAKE_SECRET}`,
      `X-Api-Key: ${FAKE_SECRET}`,
      `postgres://person:${FAKE_SECRET}@db.example.invalid/app?sslmode=require&password=${FAKE_SECRET}`,
    ]);

    // Assert
    should(actual).deepEqual([
      '-c',
      hid(`mcp_servers.x.env.API_KEY=${HIDDEN}`),
      hid(`--header=Authorization: ${HIDDEN}`),
      hid(`X-Api-Key: ${HIDDEN}`),
      hid(`postgres://person:${HIDDEN}@db.example.invalid/app?sslmode=require&password=${HIDDEN}`),
    ]);
  });

  const cases = nestedFamily();

  it(`R-0082 should hide every nested secret of every generated shape (${String(cases.length)} shapes) in flags and arguments, and touch no control`, () => {
    // Act
    const breaches = cases.flatMap(family => {
      const flag = nestedBreach(family, asShown(flagsOf(family.words)));
      const arg = nestedBreach(family, asShown(argsOf(family.words)));
      return [flag, arg].filter(breach => breach !== undefined);
    });

    // Assert
    should(cases.filter(family => family.secret).length).be.above(1000);
    should(breaches).deepEqual([]);
  });
});

describe('componentDetail — the #40 rule after review r1 (R-0082, F2, F3)', () => {
  const NESTED = 'nested-fake-value-0000';

  it('R-0082 should hide at least what #37 hid when a token is stuck to -H before a nested key, in flags and arguments (F2)', () => {
    // Arrange
    const words = [`-H${FAKE_TOKEN} API_KEY=${NESTED}`, `-H${FAKE_TOKEN}=API_KEY=${NESTED}`];

    // Assert
    should(flagsOf(words)).deepEqual([hid(`-H${HIDDEN}`), hid(`-H${HIDDEN}`)]);
    should(argsOf(words)).deepEqual([hid(`-H${HIDDEN}`), hid(`-H${HIDDEN}`)]);
  });

  it("R-0082 should cut a URL password with a raw @ and a quoted nested value with a separator whole, and a key in a flag's own part (F3)", () => {
    // Arrange
    const words = [
      `https://person:p@ss${FAKE_SECRET}@db.example.invalid/x`,
      `--set=API_KEY="${FAKE_SECRET},more${FAKE_SECRET}",b=2`,
      `--hdr,api_key:${NESTED} more`,
    ];
    const expected = [
      hid(`https://person:${HIDDEN}@db.example.invalid/x`),
      hid(`--set=API_KEY=${HIDDEN},b=2`),
      hid(`--hdr,api_key:${HIDDEN}`),
    ];

    // Assert
    should(flagsOf(words)).deepEqual(expected);
    should(argsOf(words)).deepEqual(expected);
  });
});

describe('componentDetail — the #40 rule after review r2 (R-0082, M1, M2, M3, G1)', () => {
  const NESTED = 'nested-fake-value-0000';
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
  const POINTER = '${secret:OTHER_TOKEN}';

  it('R-0082 should hide a secret-named key after a pointer, and a piece set apart from one, in flags and arguments (M1)', () => {
    // Arrange
    const words = [
      `--env API_KEY=${POINTER} CLIENT_SECRET=${NESTED}`,
      `--x=password=${POINTER}?password:${NESTED}`,
      `--header=Authorization: ${NESTED} LOG_LEVEL=${POINTER}`,
      `-c env.API_KEY=${NESTED} ${POINTER}`,
    ];
    const expected = [
      hid(`--env API_KEY=${POINTER} CLIENT_SECRET=${HIDDEN}`),
      hid(`--x=password=${POINTER}?password:${HIDDEN}`),
      hid(`--header=Authorization: ${HIDDEN} LOG_LEVEL=${POINTER}`),
      hid(`-c env.API_KEY=${HIDDEN}`),
    ];

    // Assert
    should(flagsOf(words)).deepEqual(expected);
    should(argsOf(words)).deepEqual(expected);
  });

  it("R-0082 should read a key stuck to a one-letter flag and the last key of a glued flag's own part, with a second cut (M2, M3)", () => {
    // Arrange
    const words = [
      `-eAPI_KEY=${NESTED},token=${NESTED}`,
      `-HAuthorization: Bearer ${NESTED}, X-Api-Key: ${NESTED}`,
      `--hdr,api_key=${NESTED};y=${POINTER};token=${NESTED}`,
    ];
    const expected = [
      hid(`-eAPI_KEY=${HIDDEN},token=${HIDDEN}`),
      hid(`-HAuthorization: ${HIDDEN}, X-Api-Key: ${HIDDEN}`),
      hid(`--hdr,api_key=${HIDDEN};y=${POINTER};token=${HIDDEN}`),
    ];

    // Assert
    should(flagsOf(words)).deepEqual(expected);
    should(argsOf(words)).deepEqual(expected);
  });

  it("R-0082 should cut a token in a glued flag's own part after -H with everything after the letter (G1)", () => {
    // Arrange
    const words = [`-H${FAKE_TOKEN},API_KEY=${NESTED}`];

    // Assert
    should(flagsOf(words)).deepEqual([hid(`-H${HIDDEN}`)]);
    should(argsOf(words)).deepEqual([hid(`-H${HIDDEN}`)]);
  });
});

describe('componentDetail — the #40 rule after review r3 (R-0082, N1)', () => {
  const NESTED = 'nested-fake-value-0000';
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
  const POINTER = '${secret:OTHER_TOKEN}';

  it("R-0082 should hide a secret-named key's value that holds = or : before a pointer later in it, in flags and arguments (N1)", () => {
    // Arrange
    const words = [
      `--header=Authorization: Basic ${NESTED}== LOG_LEVEL=${POINTER}`,
      `--env API_KEY=${NESTED}= MODEL=${POINTER}`,
      `API_KEY=person:${NESTED} ${POINTER}`,
      `--header=Authorization: Basic person:${NESTED} ${POINTER}`,
    ];
    const expected = [
      hid(`--header=Authorization: ${HIDDEN} LOG_LEVEL=${POINTER}`),
      hid(`--env API_KEY=${HIDDEN} MODEL=${POINTER}`),
      hid(`API_KEY=${HIDDEN} ${POINTER}`),
      hid(`--header=Authorization: ${HIDDEN} ${POINTER}`),
    ];

    // Assert
    should(flagsOf(words)).deepEqual(expected);
    should(argsOf(words)).deepEqual(expected);
  });

  it("R-0082 #40 B1 should hide a secret-named flag's value whatever pointer follows it, and padding after a pointer (B2), in flags and arguments", () => {
    // Arrange
    const words = [
      '--token',
      `${NESTED} ${POINTER}`,
      '--client-secret',
      `Basic ${NESTED}#${POINTER}`,
      `--password ${NESTED} ${POINTER}`,
      `API_KEY=${POINTER} ${NESTED}==`,
      '--model',
      `${NESTED} ${POINTER}`,
    ];
    const expected = [
      '--token',
      hid(HIDDEN),
      '--client-secret',
      hid(HIDDEN),
      hid(`--password ${HIDDEN}`),
      hid(`API_KEY=${HIDDEN}`),
      '--model',
      `${NESTED} ${POINTER}`,
    ];

    // Assert
    should(flagsOf(words)).deepEqual(expected);
    should(argsOf(words)).deepEqual(expected);
  });
});

describe('componentDetail — one rule with the Resolved view (rulings #39, #40)', () => {
  it('R-0082 should show every launch flag word for word as the Resolved view does (the #37 and #40 families)', () => {
    // Arrange
    const lines = [
      ...nestedFamily().map(family => family.words),
      ['--token', FAKE_SECRET, `--header=Bearer ${FAKE_GH}`, `-H${FAKE_TOKEN}`, '--model', 'x'],
    ];

    // Act
    const differs = lines.filter(words => {
      const model = parseAccountModel({
        version: 1,
        components: { settings: { base: { harness: 'claude', flags: [...words] } } },
        profiles: { p: { layers: ['settings/base'] } },
      });
      const result = resolveProfile({ model, profile: 'p', harness: 'claude' });
      if (!result.ok) throw new Error('expected a resolution');
      const preview = resolvedEntries(result.resolved)
        .filter(entry => entry.field === 'flags')
        .map(entry => (entry.hidden === true ? { value: entry.value, hidden: true } : { value: entry.value }));
      return JSON.stringify(preview) !== JSON.stringify(asShown(flagsOf(words)));
    });

    // Assert
    should(lines.length).be.above(1000);
    should(differs.slice(0, 5)).deepEqual([]);
  });
});
