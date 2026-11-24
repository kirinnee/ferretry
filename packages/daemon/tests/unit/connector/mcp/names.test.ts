import { describe, it } from 'bun:test';
import should from 'should';
import { editDistance, matchName, normalizeName } from '../../../../src/lib/connector/mcp/names.ts';

interface Row {
  readonly id: string;
  readonly callsign: string;
  readonly task: string;
}
const rows: Row[] = [
  { id: 'mwuanehg-4531fa9e', callsign: 'lizzette', task: '[Lizzette] Build MCP Connector' },
  { id: 'mxk2aa11-0001ffff', callsign: 'marin', task: 'Fix the login page' },
  { id: 'mxk2bb22-0002ffff', callsign: 'marina', task: 'Fix the logout page' },
];
const keys = (row: Row) => ({
  exact: [row.id, row.id.split('-')[0] as string],
  names: [row.callsign, row.task, row.task.replace(/^\[[^\]]*\]\s*/u, '')],
});

describe('normalizeName', () => {
  it('ignores case, spaces, hyphens, a leading colon and doubled letters', () => {
    should(normalizeName(':Lizzette')).equal(normalizeName('lizete'));
    should(normalizeName('Mary-Jane')).equal(normalizeName('mary jane'));
  });
  it('folds spelling-alikes', () => {
    should(normalizeName('Phil')).equal(normalizeName('fil'));
  });
});

describe('editDistance', () => {
  it('counts a swap as one edit', () => {
    should(editDistance('abcd', 'abdc')).equal(1);
  });
  it('is zero for equal strings', () => {
    should(editDistance('x', 'x')).equal(0);
  });
});

describe('matchName', () => {
  it('matches a callsign exactly, case-insensitively', () => {
    const result = matchName('Lizzette', rows, keys);
    should(result.kind).equal('one');
  });
  it('matches a session id and its short id', () => {
    should(matchName('mwuanehg-4531fa9e', rows, keys).kind).equal('one');
    const short = matchName('mwuanehg', rows, keys);
    should(short.kind).equal('one');
  });
  it('matches the task title with or without its bracket tag, spaces and case ignored', () => {
    should(matchName('build m c p connector', rows, keys).kind).equal('one');
    should(matchName('BUILD-MCP-CONNECTOR', rows, keys).kind).equal('one');
  });
  it('acts on a unique prefix or substring only', () => {
    should(matchName('lizz', rows, keys).kind).equal('one');
    should(matchName('login', rows, keys).kind).equal('one');
  });
  it('asks which when several match at the best tier', () => {
    const result = matchName('fix', rows, keys);
    should(result.kind).equal('many');
  });
  it('prefers an exact match over longer names that start with it', () => {
    const result = matchName('marin', rows, keys);
    should(result.kind).equal('one');
    if (result.kind === 'one') should(result.item.callsign).equal('marin');
  });
  it('never acts on a close miss: it only suggests', () => {
    const result = matchName('lizet', rows, keys);
    should(result.kind).equal('one'); // "lizet" is a prefix of "lizzette" once doubled letters collapse
  });
  it('suggests up to three close matches for a misheard name', () => {
    const result = matchName('lizzete x', rows, keys);
    should(result.kind).equal('none');
    if (result.kind === 'none') should(result.suggestions.length).be.belowOrEqual(3);
  });
  it('suggests, not acts, for a transposed name', () => {
    const result = matchName('lizztete', rows, keys);
    if (result.kind === 'none') should(result.suggestions.map(r => r.callsign)).containEql('lizzette');
    else should(result.kind).equal('none');
  });
  it('returns nothing for an empty query or a stranger', () => {
    should(matchName('', rows, keys)).eql({ kind: 'none', suggestions: [] });
    const far = matchName('zzzzzzzz', rows, keys);
    should(far.kind).equal('none');
    if (far.kind === 'none') should(far.suggestions.length).equal(0);
  });
});
