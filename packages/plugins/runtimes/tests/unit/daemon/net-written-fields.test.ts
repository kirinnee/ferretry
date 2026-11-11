/**
 * CFG-LEAK (ii) the text a component's detail shows AS WRITTEN (an MCP server's `command` and `url`) and the values shown
 * under a name (an environment value, in the detail and in the Resolved view) go through the same fail-closed net as the
 * word lists: a text the write rule refuses, or that the word cutter would cut, is WITHHELD whole, never in part.
 *
 * The sample below is the shape of the acceptance corpus (F1-F7 × leads × marks) placed in `command`, and in `command` +
 * `args`. Fake only: every value is shaped like a credential and is none.
 *
 * Per-test limit (testing standard, measured limits): the sample test reads ~1,000 lines in two placements; it runs in
 * about 1 s alone with `--coverage` under bun 1.4.4, so its 5 s limit is a margin, not the measurement.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { findFlagSecrets, findRawSecrets } from '@ferretry/std/credential-words';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { type CatalogFacts, componentCatalog } from '../../../daemon/lib/service/catalog.ts';
import { resolvedEntries } from '../../../daemon/lib/service/resolved-view.ts';
import { writtenWithheld } from '../../../daemon/lib/service/command-line.ts';

const V = 'Zk3pQ9vXw2LmN7rT';
const GSK = 'gsk_AbCdEfGhIjKlMnOpQrSt12';
const LONG40 = 'Zk3pQ9vXw2LmN7rTHy8cBt4Fg6SdJ1uEqW5eR0tY';
const P = '${secret:X}';
const RAWS = [V, GSK, LONG40, `${V}a`, 'Hy8cBt4Fg6SdJ1uE'];
const MARKS = [',', ';', '&'];

const FACTS: CatalogFacts = {
  format: 'present',
  machineName: 'studio',
  tools: { claude: '/usr/bin/claude', codex: undefined },
  runningSessions: 0,
  userHome: '/home/person',
  acceptsAutoPermissionMode: true,
};

const windowsOf = (secret: string): readonly string[] =>
  Array.from({ length: Math.max(0, secret.length - 7) }, (_, at) => secret.slice(at, at + 8));
const WINDOWS = RAWS.flatMap(windowsOf);
const showsSecret = (text: string): boolean => WINDOWS.some(window => text.includes(window));

const SHAPES: readonly ((mark: string, raw: string) => string)[] = [
  (mark, raw) => `a${mark}${raw}`,
  (mark, raw) => `\${X}${mark}${raw}`,
  (mark, raw) => `${P}${mark}\t${raw}`,
  (mark, raw) => `${P}${mark} ${raw}`,
  (mark, raw) => `https://u:${P}@h/p${mark}${raw}`,
  (mark, raw) => `.a=${P}${mark}b=${raw}`,
  (mark, raw) => `\${secret:X${mark}${raw}}`,
  (mark, raw) => `${P}${mark}b=2${mark}${raw}`,
];
const LEADS: readonly ((value: string) => readonly string[])[] = [
  value => ['--key', value],
  value => ['--token', value],
  value => [`--token=${value}`],
  value => [`--api-key=${value}`],
  value => ['-e', `API_KEY=${value}`],
  value => [`API_KEY=${value}`],
  value => ['-H', `Authorization: Bearer ${value}`],
  value => ['--password', value],
  value => [`srv --token ${value}`],
  value => [`--token=${value} x`],
  value => ['sh', '-c', `srv --token ${value}`],
];

const LINES: readonly (readonly string[])[] = RAWS.flatMap(raw =>
  MARKS.flatMap(mark => SHAPES.flatMap(shape => LEADS.map(lead => lead(shape(mark, raw))))),
).filter(line => findFlagSecrets({ args: line }).length > 0);

const model = (components: Record<string, unknown>, profiles: Record<string, unknown> = {}) =>
  parseAccountModel({ version: 1, components, profiles });

const mcpDetail = (server: Record<string, unknown>) => {
  const found = componentCatalog(model({ mcp: { srv: server } }), FACTS)
    .kinds.flatMap(group => group.components)
    .find(component => component.reference === 'mcp/srv');
  if (found === undefined || found.detail.kind !== 'mcp') throw new Error('no mcp/srv detail');
  return found.detail;
};

/** Every character the detail shows of the server's start: command, url and each argument. */
const shownStart = (server: Record<string, unknown>): string => {
  const detail = mcpDetail(server);
  const words = (detail.args ?? []).map(word => (typeof word === 'string' ? word : word.shown));
  return [detail.command ?? '', detail.url ?? '', ...words].join('\n');
};

describe('CFG-LEAK (ii) an MCP server command and url are netted in the component detail', () => {
  it('the sample is more than 500 lines the write rule refuses', () => {
    should(LINES.length).be.above(500);
  });

  // Limit 5 s: about 1 s alone (see the file header).
  it('a command that holds a refused line shows no part of a secret: one string, and command + arguments', () => {
    let refused = 0;
    const leaked = LINES.flatMap(line => {
      const joined = line.join(' ');
      const [first = '', ...rest] = line;
      // Only a document the write rule refuses as it stands: a command beside its arguments is two fields to it.
      return [{ command: joined }, { command: first, args: rest }]
        .filter(server => findFlagSecrets(server).length > 0 || findRawSecrets({ command: server.command }).length > 0)
        .flatMap(server => {
          refused += 1;
          return showsSecret(shownStart(server)) ? [JSON.stringify(server).slice(0, 120)] : [];
        });
    });
    should(refused).be.above(500);
    should(leaked).eql([]);
  }, 5_000);

  it('withholds the command whole: it is absent, the flag is set, and nothing of the line is in the detail', () => {
    const detail = mcpDetail({ command: `srv --token ${V}` });
    should(detail.commandWithheld).be.true();
    should(detail.command).be.undefined();
    should(JSON.stringify(detail)).not.containEql(V);
  });

  it('a command beside arguments that refuse stays shown; the arguments are withheld by their own net', () => {
    const detail = mcpDetail({ command: 'sh', args: ['-c', `srv --token ${V}`] });
    should(detail.command).equal('sh');
    should(detail.argsWithheld).be.true();
    should(JSON.stringify(detail)).not.containEql(V);
  });

  it('shows an ordinary command and arguments as written, with nothing withheld', () => {
    const detail = mcpDetail({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] });
    should(detail.command).equal('npx');
    should(detail.commandWithheld).be.undefined();
    should(detail.args).eql(['-y', '@modelcontextprotocol/server-github']);
  });

  it('withholds a url that holds a user and password, or a token in its query; a bare url is shown', () => {
    const user = mcpDetail({ url: `https://u:${V}@h.example/p` });
    should(user.urlWithheld).be.true();
    should(user.url).be.undefined();
    should(JSON.stringify(user)).not.containEql(V);
    const query = mcpDetail({ url: `https://h.example/p?api_key=${V}` });
    should(query.urlWithheld).be.true();
    should(JSON.stringify(query)).not.containEql(V);
    const bare = mcpDetail({ url: 'https://h.example/mcp' });
    should(bare.url).equal('https://h.example/mcp');
    should(bare.urlWithheld).be.undefined();
  });

  it('hides an environment value the write rule refuses under a name that is no credential name', () => {
    const detail = mcpDetail({
      command: 'srv',
      env: { PATH: `https://u:${V}@h/p`, HOME: '/home/person', SEEN: 'plain' },
    });
    should(detail.env).eql([
      { name: 'HOME', value: '/home/person' },
      { name: 'PATH', hidden: true },
      { name: 'SEEN', value: 'plain' },
    ]);
  });

  it('the Resolved view hides the same environment value', () => {
    const parsed = model(
      { settings: { base: { harness: 'claude', file: 'base.json', env: { PATH: `https://u:${V}@h/p`, HOME: '/h' } } } },
      { p: { layers: ['settings/base'] } },
    );
    const result = resolveProfile({ model: parsed, profile: 'p', harness: 'claude', settingsBodies: { base: {} } });
    if (!result.ok) throw new Error('expected a resolution');
    const env = resolvedEntries(result.resolved).filter(entry => entry.field === 'env');
    should(JSON.stringify(env)).not.containEql(V);
    should(env.find(entry => entry.key.endsWith('PATH'))?.hidden).be.true();
    should(env.find(entry => entry.key.endsWith('HOME'))?.hidden).be.undefined();
  });

  it('hides a settings value the write rule refuses', () => {
    const parsed = model({
      settings: { base: { harness: 'claude', file: 'base.json' } },
      instructions: { notes: { text: 'x' } },
    });
    const shown = (facts: Partial<CatalogFacts>) =>
      componentCatalog(parsed, { ...FACTS, ...facts }).kinds.flatMap(group => group.components);
    const long = `${V}${V}${V}`;
    const found = shown({
      settingsBodies: { base: { apiUrl: `https://u:${V}@h/p`, name: 'plain' } },
      instructionBodies: { notes: `intro\nkey: ${long}\n` },
    });
    const entries = found.find(component => component.kind === 'settings')?.content;
    should(JSON.stringify(entries)).not.containEql(V);
    should(entries?.form === 'entries' ? entries.entries.find(entry => entry.key === 'name') : undefined).eql({
      key: 'name',
      value: 'plain',
    });
  });

  it('the "command not found" warning does not name a command the detail withholds', () => {
    const parsed = model({
      mcp: { held: { command: `srv --token ${V}` }, plain: { command: 'uvx' } },
    });
    const warnings = componentCatalog(parsed, { ...FACTS, missingCommands: new Set([`srv --token ${V}`, 'uvx']) })
      .kinds.flatMap(group => group.components)
      .flatMap(component => component.warnings);
    should(warnings.toSorted()).eql(['Command not found', 'Command not found: uvx']);
  });

  it('writtenWithheld judges the text alone: a refused flag, a token shape, a cut part; not a plain word', () => {
    should(writtenWithheld('command', 'srv')).be.false();
    should(writtenWithheld('command', `srv --token ${V}`)).be.true();
    should(writtenWithheld('command', `sk-${V}`)).be.true();
    should(writtenWithheld('url', `https://h.example/p?token=${V}`)).be.true();
    // The write rule reads a command and its arguments as two fields: the arguments have their own net.
    should(writtenWithheld('command', 'srv --token')).be.false();
  });

  it('a withheld argument list leaves the command shown: only what refuses is withheld', () => {
    const detail = mcpDetail({ command: 'npx', args: ['--token', V] });
    should(detail.command).equal('npx');
    should(detail.commandWithheld).be.undefined();
    should(JSON.stringify(detail)).not.containEql(V);
  });
});
