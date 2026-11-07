import { describe, it } from 'bun:test';
import type { SharedCatalogItem } from '../../../daemon/lib/boundary.ts';
import should from 'should';
import {
  conservativeChanges,
  HIDDEN_WARNING,
  MAX_SCANNED,
  foldedForScan,
  isKnownTokenShape,
  joinedLines,
  mayHoldSecret,
  namesSecret,
  withoutInvisible,
} from '../../../daemon/lib/catalog-installs/conservative-changes.ts';

const base = { format: 'ferretry-catalog-item', version: 1, publisher: 'p', catalogId: 'c', itemId: 'i', name: 'x' };
const mcp = (setup: object) =>
  ({ ...base, kind: 'mcp', mcp: setup }) as unknown as Extract<SharedCatalogItem, { kind: 'mcp' }>;
const command = (extra: object) => mcp({ transport: 'command', command: 'run', args: [], env: {}, ...extra });
const skill = (...files: [string, string][]) =>
  ({
    ...base,
    kind: 'skill',
    skill: { files: files.map(([path, content]) => ({ path, content })) },
  }) as unknown as Extract<SharedCatalogItem, { kind: 'skill' }>;

describe('mayHoldSecret', () => {
  it.each([
    ['password: x'],
    ['PASSWD=x'],
    ['the Secret is'],
    ['apikey 1'],
    ['api-key'],
    ['X-Auth-Header'],
    ['credentials'],
    ['ghp_x'],
    ['github_pat_x'],
    ['use sk-ant'],
    ['xoxb-1'],
    ['AKIAIOSFODNN7EXAMPLE'],
    ['ASIAXXXX'],
    ['glpat-x'],
    ['npm_x'],
    ['hf_x'],
    ['AIzaSyX'],
    ['eyJhbGci'],
    ['-----BEGIN CERTIFICATE-----'],
    ['a ${X} b'],
    ['${X:-default}'],
    ['0123456789abcdef01234567'],
    ['c2VjcmV0cGFzc3dvcmQ='.repeat(2)],
    ['https://u:p@host/x'],
    ['u:p@host'],
    [`pa${String.fromCodePoint(0xad)}ss`],
    ['gh\np_x'],
    [`pa${String.fromCodePoint(0xad)}ss`.replace(String.fromCodePoint(0xad), '⟨U+00AD⟩')],
    ['to⟨U+200B⟩ken=x'],
    ['pa⟨U+000D⟩ss: x'],
    ['pa\rss: x'],
    ['curl -u bob:x'],
    ['mysql -phunter2'],
    ['redis-cli -a x'],
    ['  -p   x'],
  ])('should trip on %j', text => {
    should(mayHoldSecret(text)).equal(true);
  });

  it.each([
    ['# one\nsame\n'],
    ['hello world'],
    [''],
    ['https://example.com/a/b?x=1'],
    ['name@example.com'],
    ['a b: c d'],
    ['ls -a'],
    ['run -x y -- -z'],
    ['-p'],
    ['-- -p--x'],
  ])('should not trip on %j', text => {
    should(mayHoldSecret(text)).equal(false);
  });

  it('should treat a text over the size bound as tripping, without reading it', () => {
    should(mayHoldSecret(' '.repeat(MAX_SCANNED + 1))).equal(true);
    should(mayHoldSecret(' '.repeat(MAX_SCANNED))).equal(false);
  });

  it.each([
    ['a prefix repeated', 'sk-'.repeat(MAX_SCANNED / 3)],
    ['colons and at-signs', ':@'.repeat(MAX_SCANNED / 2)],
    ['scheme marks', '://'.repeat(MAX_SCANNED / 3)],
    ['scheme marks with no end', `://${'a'.repeat(MAX_SCANNED - 3)}`],
    ['line breaks', '\n'.repeat(MAX_SCANNED)],
    ['plain prose', 'lorem ipsum '.repeat(MAX_SCANNED / 12)],
  ])('should finish in linear time on 2 MiB of %s', (_label, text) => {
    const started = performance.now();
    mayHoldSecret(text);
    should(performance.now() - started).be.below(2_000);
  });
});

describe('conservativeChanges', () => {
  it('should draw an ordinary change as the normal diff', () => {
    const changes = conservativeChanges(skill(['a.md', 'x\nold\n']), skill(['a.md', 'x\nnew\n']));
    should(changes.entries[0]?.hunks).be.ok();
    should(changes.entries[0]?.hidden).be.undefined();
  });

  it('should hide an entry when either side trips, and keep its flag', () => {
    const changes = conservativeChanges(skill(['run.sh', 'echo hi\n']), skill(['run.sh', 'echo $TOKEN\nTOKEN=abc\n']));
    should(changes.entries).eql([
      { label: 'Skill file run.sh', change: 'changed', document: true, hidden: true, flag: 'script' },
    ]);
    const other = conservativeChanges(skill(['a.md', 'password: plain.word.one\n']), skill(['a.md', 'hello\n']));
    should(JSON.stringify(other)).not.match(/plain\.word\.one/u);
  });

  it('should leave an unchanged entry unchanged even when it would trip', () => {
    const changes = conservativeChanges(skill(['a.md', 'token: x\n']), skill(['a.md', 'token: x\n']));
    should(changes.entries).eql([]);
    should(changes.unchanged).equal(1);
  });

  it('should never show an environment value, tripped or not', () => {
    const changes = conservativeChanges(
      command({ env: { A: 'val-aaa', B: 'val-ccc' } }),
      command({ env: { A: 'val-bbb' } }),
    );
    should(JSON.stringify(changes)).not.match(/val-/u);
    should(changes.entries.map(entry => [entry.label, entry.change, entry.hidden])).eql([
      ['Environment A', 'changed', true],
      ['Environment B', 'changed', true],
    ]);
  });

  it('should hide a changed command that carries a flag naming a secret', () => {
    const changes = conservativeChanges(command({ args: ['--password', 'hunter2'] }), command({ args: ['--stdio'] }));
    should(JSON.stringify(changes)).not.match(/hunter2/u);
    should(changes.entries[0]?.hidden).equal(true);
  });

  it('should replace a warning that carries a tripping address, and keep one that does not', () => {
    const was = mcp({ transport: 'url', url: 'https://u:p@old.example.com/x' });
    const now = mcp({ transport: 'url', url: 'https://new.example.com/x' });
    const changes = conservativeChanges(was, now);
    should(changes.goneWarnings.map(warning => warning.text)).eql([HIDDEN_WARNING]);
    should(changes.newWarnings[0]?.text).match(/new\.example\.com/u);
  });

  it('should spend one budget across every file', () => {
    const budget = { remaining: 0 };
    const changes = conservativeChanges(skill(['a.md', 'x\n1\n']), skill(['a.md', 'x\n2\n']), budget);
    should(changes.truncated).equal(true);
  });
});

describe('mayHoldSecret over look-alike forms', () => {
  it('reads full-width letters as the plain ones they stand for', () => {
    should(mayHoldSecret('ｐａｓｓｗｏｒｄ is here')).equal(true);
    should(mayHoldSecret(`${'Ａ'.repeat(30)}`)).equal(true);
    should(mayHoldSecret('ｈｅｌｌｏ ｗｏｒｌｄ')).equal(false);
  });
});

describe('the helpers the copy refusal shares', () => {
  it('strips invisible characters, joins lines, folds, and names secrets', () => {
    should(withoutInvisible('a​b⟨U+00AD⟩c')).equal('abc');
    should(joinedLines('a\r\nb\nc')).equal('abc');
    should(foldedForScan('Ａ​Ｂ')).equal('AB');
    should(namesSecret('X-Auth')).equal(true);
    should(namesSecret('colour')).equal(false);
  });

  it('should know a well-known token by its prefix, length and a digit', () => {
    should(isKnownTokenShape(`ghp_${'0'.repeat(36)}`)).equal(true);
    should(isKnownTokenShape(`GHP_${'0'.repeat(36)}`)).equal(true);
    should(isKnownTokenShape(`sk-ant-api03-${'1'.repeat(20)}`)).equal(true);
    should(isKnownTokenShape(`xoxb-${'2'.repeat(20)}`)).equal(true);
    should(isKnownTokenShape(`AKIA${'3'.repeat(16)}`)).equal(true);
    should(isKnownTokenShape(`akia${'3'.repeat(16)}`)).equal(false);
    should(isKnownTokenShape(`eyJ${'4'.repeat(30)}`)).equal(true);
    should(isKnownTokenShape('ghp_short1')).equal(false);
    should(isKnownTokenShape('sk-learn-is-a-python-library')).equal(false);
    should(isKnownTokenShape(`ghp_${'0'.repeat(30)}!`)).equal(false);
    should(isKnownTokenShape(`-----BEGIN${'0'.repeat(30)}`)).equal(false);
    should(isKnownTokenShape(`plain${'0'.repeat(30)}`)).equal(false);
  });
});
