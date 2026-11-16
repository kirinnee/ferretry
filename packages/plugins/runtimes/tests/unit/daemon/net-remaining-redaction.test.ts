/**
 * The three values the redaction still SHOWED after PR 1767 (c58-63 follow-up, fix-63b). Rule: redaction fails CLOSED,
 * and the one-string `command` form never shows more than the args form.
 *
 *  B1. a one-string MCP `command` that holds a JSON document with a blank in it (the args form withheld it);
 *  B2. the args form `--header Authorization: /V` (a "place" right after a Header: is never a place);
 *  B3. a broken document whose secret key is written in \u escapes.
 *
 * Fake values only.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { type CatalogFacts, componentCatalog } from '../../../daemon/lib/service/catalog.ts';
import { commandWithheld } from '../../../daemon/lib/service/command-line.ts';
import { resolvedEntries } from '../../../daemon/lib/service/resolved-view.ts';
import { viewsOf } from './net-views.ts';

const V = 'Zk3pQ9vXw2LmN7rTq8Yb';
const FACTS: CatalogFacts = {
  format: 'present',
  machineName: 'studio',
  tools: { claude: '/usr/bin/claude', codex: undefined },
  runningSessions: 0,
  userHome: '/home/person',
  acceptsAutoPermissionMode: true,
};

/** What the Resolved line and the detail show of a server started by the one string `command`. */
function oneString(command: string) {
  const parsed = parseAccountModel({
    version: 1,
    components: { mcp: { srv: { command, args: [] } } },
    profiles: { p: { layers: ['mcp/srv'] } },
  });
  const result = resolveProfile({ model: parsed, profile: 'p', harness: 'claude', settingsBodies: {} });
  if (!result.ok) throw new Error('expected a resolution');
  const resolved = resolvedEntries(result.resolved).find(entry => entry.field === 'mcp')?.value ?? '';
  const detail = componentCatalog(parsed, FACTS)
    .kinds.flatMap(group => group.components)
    .find(component => component.reference === 'mcp/srv')?.detail;
  return { resolved, detail: JSON.stringify(detail) };
}

/** Both forms: the one string `srv <rest>` and the args form (`words`), each shows no part of V in any view. */
function showsNoValueInBothForms(rest: string, words: readonly string[]): void {
  const command = `srv ${rest}`;
  // One string
  const seen = oneString(command);
  should(commandWithheld(command)).be.true();
  should(seen.resolved).not.containEql(V);
  should(seen.detail).not.containEql(V);
  // Args
  for (const view of viewsOf(words)) should(view.text).not.containEql(V);
}

describe('B1: a one-string command that holds a JSON document with a blank shows no value of it', () => {
  const DOCUMENTS: readonly (readonly [string, string, readonly string[]])[] = [
    ['a pair with a blank after the colon', `--settings {"API_KEY": "${V}"}`, ['--settings', `{"API_KEY": "${V}"}`]],
    ['a pair with blanks inside the braces', `--settings { "API_KEY":"${V}" }`, ['--settings', `{ "API_KEY":"${V}" }`]],
    [
      'a nested env document',
      `--settings {"env": {"API_KEY": "${V}"}}`,
      ['--settings', `{"env": {"API_KEY": "${V}"}}`],
    ],
    ['a document in single quotes', `--settings '{"API_KEY": "${V}"}'`, ['--settings', `'{"API_KEY": "${V}"}'`]],
    ['a document glued with =', `--settings={"API_KEY": "${V}"}`, [`--settings={"API_KEY": "${V}"}`]],
    ['a password document with no flag', `{"password": "${V}"}`, [`{"password": "${V}"}`]],
    ['a broken document with a missing comma', `{"x":"y" "API_KEY":"${V}"}`, [`{"x":"y" "API_KEY":"${V}"}`]],
    ['a document with a comment', `{ // c\n"API_KEY":"${V}"}`, [`{ // c\n"API_KEY":"${V}"}`]],
  ];
  for (const [name, rest, words] of DOCUMENTS) {
    it(`should withhold ${name}, in both forms`, () => {
      showsNoValueInBothForms(rest, words);
    });
  }

  it('should withhold a command in which many words open a document (each is read to the end: bounded)', () => {
    // Act / Assert
    should(commandWithheld(`srv ${'{a '.repeat(40)}`)).be.true();
    should(commandWithheld(`srv ${'{a '.repeat(3)}`)).be.false();
  });

  it('should still show a document that holds no credential', () => {
    // Arrange
    const command = 'srv --settings {"theme": "dark", "tabs": 2}';

    // Act / Assert
    should(commandWithheld(command)).be.false();
    should(oneString(command).resolved).equal(command);
  });
});

describe('B2: a place is never the word after a Header: in the args form', () => {
  it('should withhold --header Authorization: /V in the args form and the one string', () => {
    showsNoValueInBothForms(`--header Authorization: /${V}`, ['--header', 'Authorization:', `/${V}`]);
  });

  it('should withhold -H X-Api-Key: ./V in the args form and the one string', () => {
    showsNoValueInBothForms(`-H X-Api-Key: ./${V}`, ['-H', 'X-Api-Key:', `./${V}`]);
  });

  it('should withhold the pair in one word, Authorization:/V, in the args form', () => {
    showsNoValueInBothForms(`-H Authorization:/${V}`, ['-H', `Authorization:/${V}`]);
  });
});

describe('B3: a broken document whose secret key is written in \\u escapes shows no value', () => {
  // `API_KEY` spelled out in escapes, whole and in part; the value is bare, so the document does not parse.
  const KEYS: readonly (readonly [string, string])[] = [
    ['every letter escaped', '\\u0041\\u0050\\u0049\\u005f\\u004b\\u0045\\u0059'],
    ['one letter escaped', '\\u0041PI_KEY'],
    ['an escaped underscore', 'API\\u005fKEY'],
    ['an upper-case hex escape', 'API\\u005FKEY'],
  ];
  for (const [name, key] of KEYS) {
    it(`should withhold ${name}`, () => {
      const document = `{"${key}": ${V}}`;
      showsNoValueInBothForms(`--settings ${document}`, ['--settings', document]);
      showsNoValueInBothForms(document, [document]);
    });
  }

  it('should not cut a broken document whose escaped key names nothing secret', () => {
    // Arrange
    const document = '{"\\u0074heme": dark}';

    // Act
    const seen = oneString(`srv ${document}`);

    // Assert
    should(seen.resolved).containEql('dark');
  });
});
