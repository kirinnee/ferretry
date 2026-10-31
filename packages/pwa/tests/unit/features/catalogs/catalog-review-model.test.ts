import { describe, it } from 'bun:test';
import type { CatalogInstallWarningCode } from '@ferretry/protocol';
import should from 'should';
import {
  fingerprintStart,
  formatBytes,
  holdsMarker,
  isLargeFile,
  LARGE_FILE_BYTES,
  LARGE_FILE_MARKERS,
  placeholderName,
  plural,
  reviewHeading,
  reviewRows,
  shortDigest,
  splitMarkers,
  warningRows,
  fileHead,
  namedByWarning,
} from '../../../../src/features/catalogs/catalog-review-model.ts';

const marker = (code: string): string => `${String.fromCodePoint(0x27e8)}U+${code}${String.fromCodePoint(0x27e9)}`;
const RLO = marker('202E');

describe('markers', () => {
  it('splits text around each marker and rejoins to the input', () => {
    const text = `before ${RLO} after ${RLO}`;
    const segments = splitMarkers(text);
    should(segments.map(segment => segment.marker)).eql([false, true, false, true]);
    should(segments.map(segment => segment.text).join('')).equal(text);
  });
  it('merges markers with nothing between them into one, counting repeats', () => {
    const zero = marker('200B');
    should(splitMarkers(zero.repeat(1000))).eql([{ marker: true, text: '⟨U+200B ×1,000⟩' }]);
    should(splitMarkers(`a${zero}${zero}${RLO}${zero}b`)).eql([
      { marker: false, text: 'a' },
      { marker: true, text: '⟨U+200B ×2⟩⟨U+202E⟩⟨U+200B⟩' },
      { marker: false, text: 'b' },
    ]);
  });
  it('treats plain text as one segment and empty text as none', () => {
    should(splitMarkers('plain')).eql([{ marker: false, text: 'plain' }]);
    should(splitMarkers('')).eql([]);
  });
  it('starts with a marker', () => {
    should(splitMarkers(RLO)).eql([{ marker: true, text: RLO }]);
  });
  it('calls a file large over 64 KiB or over 200 markers, and nothing smaller', () => {
    should(isLargeFile('a'.repeat(LARGE_FILE_BYTES))).be.false();
    should(isLargeFile('a'.repeat(LARGE_FILE_BYTES + 1))).be.true();
    should(isLargeFile(RLO.repeat(LARGE_FILE_MARKERS))).be.false();
    should(isLargeFile(RLO.repeat(LARGE_FILE_MARKERS + 1))).be.true();
    should(
      reviewRows([{ label: 'Skill file big.md', text: 'z'.repeat(LARGE_FILE_BYTES + 1), document: true }])[0],
    ).containEql({ large: true });
  });
  it('knows whether a marker is present', () => {
    should(holdsMarker(`a${RLO}`)).be.true();
    should(holdsMarker('a')).be.false();
  });
});

describe('reviewRows', () => {
  it('turns skill files into file rows and the rest into lines', () => {
    const rows = reviewRows([
      { label: 'Skill file SKILL.md', text: 'one\ntwo', document: true },
      { label: 'Skill file empty.md', text: '', document: true },
      { label: 'Starts', text: 'acme --stdio', document: false },
      { label: 'Environment ACME_TOKEN', text: '${secret:ACME_TOKEN}', document: false },
      { label: 'Environment REGION', text: 'eu', document: false },
      { label: 'Starts', text: `x${RLO}`, document: false },
      { label: 'Other', text: '${secret:ACME_TOKEN}', document: false },
    ]);
    should(rows[0]).eql({ kind: 'file', path: 'SKILL.md', text: 'one\ntwo', lines: 2, marked: false, large: false });
    should(rows[1]).containEql({ kind: 'file', path: 'empty.md', lines: 0 });
    should(rows[2]).eql({ kind: 'line', label: 'Starts', text: 'acme --stdio', marked: false });
    should(rows[3]).containEql({ placeholder: 'ACME_TOKEN' });
    should(rows[4]).not.have.property('placeholder');
    should(rows[5]).containEql({ marked: true });
    should(rows[6]).not.have.property('placeholder');
  });
  it('reads only a whole placeholder', () => {
    should(placeholderName('${secret:A_B}')).equal('A_B');
    should(placeholderName('x${secret:A_B}')).be.undefined();
    should(placeholderName('${secret:a}')).be.undefined();
  });
  it('headlines files or a setup', () => {
    const file = reviewRows([{ label: 'Skill file SKILL.md', text: 'x', document: true }]);
    const line = reviewRows([{ label: 'Starts', text: 'x', document: false }]);
    should(reviewHeading(file)).match(/files/u);
    should(reviewHeading(line)).match(/setup/u);
  });
  it('words the heading for the one installing, not the one publishing', () => {
    const file = reviewRows([{ label: 'Skill file SKILL.md', text: 'x', document: true }]);
    const line = reviewRows([{ label: 'Starts', text: 'x', document: false }]);
    should(reviewHeading(file, 'installer')).equal('What this brings, in full');
    should(reviewHeading(line, 'installer')).equal('It will run');
    should(reviewHeading(file, 'publisher')).not.match(/brings/u);
  });
  it('writes a raw hidden character as its marker, in a file, a line and a label', () => {
    const raw = String.fromCodePoint(0x202e);
    const rows = reviewRows([
      { label: `Skill file a${raw}.md`, text: `run ${raw}x`, document: true },
      { label: 'Starts', text: `cmd ${raw}`, document: false },
    ]);
    for (const row of rows) {
      should(JSON.stringify(row)).not.containEql(raw);
      should(row.marked).be.true();
    }
    should(rows[0]).containEql({ kind: 'file', path: 'a⟨U+202E⟩.md' });
  });
});

describe('warningRows', () => {
  it('puts the older version first and keeps the daemon order for ties', () => {
    const codes: readonly CatalogInstallWarningCode[] = [
      'first-publisher',
      'network-url',
      'unpinned-package',
      'older-version',
      'unpinned-package',
    ];
    const rows = warningRows(codes.map((code, index) => ({ code, text: `t${index}` })));
    should(rows.map(row => row.code)).eql([
      'older-version',
      'unpinned-package',
      'unpinned-package',
      'network-url',
      'first-publisher',
    ]);
    should(rows[1]?.text).equal('t2');
    should(rows[2]?.text).equal('t4');
    should(rows[0]).containEql({ tone: 'danger' });
    should(rows[3]).containEql({ tone: 'caution' });
    should(rows[4]).containEql({ tone: 'note' });
  });
  it('gives every code a label', () => {
    const all: readonly CatalogInstallWarningCode[] = [
      'unpinned-package',
      'network-url',
      'carries-scripts',
      'older-version',
      'edited-locally',
      'first-publisher',
      'package-registry',
      'runs-on-its-own',
      'hidden-characters',
      'possible-secret',
    ];
    for (const row of warningRows(all.map(code => ({ code, text: 'x' })))) should(row.label.length).be.above(0);
  });
});

describe('numbers and names', () => {
  it('shortens a digest and a fingerprint', () => {
    should(shortDigest(`sha256:${'ab'.repeat(32)}`)).equal('sha256:abababababab…');
    should(shortDigest('weird')).equal('weird');
    const full = `fy_daemon_${'q3XkAbCdEfGhIjKlMnOp'}${'z'.repeat(23)}`;
    should(fingerprintStart(full)).equal('fy_daemon_q3XkAbCdEfGhIjKlMnOp…');
    should(fingerprintStart('fy_daemon_short')).equal('fy_daemon_short');
    should(fingerprintStart('other-id-that-is-long')).equal('other-id-that-…');
  });
  it('formats bytes', () => {
    should(formatBytes(12)).equal('12 B');
    should(formatBytes(2048)).equal('2.0 KB');
    should(formatBytes(3 * 1024 * 1024)).equal('3.0 MB');
  });
  it('pluralises', () => {
    should(plural(1, 'item')).equal('1 item');
    should(plural(2, 'item')).equal('2 items');
    should(plural(2, 'person', 'people')).equal('2 people');
  });
});

describe('fileHead', () => {
  it('keeps a short file as it is', () => {
    should(fileHead('a\nb')).equal('a\nb');
  });

  it('keeps only the first 40 lines', () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`);
    const head = fileHead(lines.join('\n')).split('\n');
    should(head).have.length(40);
    should(head[39]).equal('line 39');
  });

  it('cuts a very long line at 400 characters and says so', () => {
    const head = fileHead('x'.repeat(5000));
    should(head).equal(`${'x'.repeat(400)}…`);
  });

  it('never cuts a marker in half', () => {
    const line = `${'x'.repeat(396)}${marker('202E')}tail`;
    should(fileHead(line)).equal(`${'x'.repeat(396)}${marker('202E')}…`);
  });

  it('cuts after a whole marker that ends before the limit', () => {
    const line = `${marker('202E')}${'y'.repeat(500)}`;
    should(fileHead(line)).equal(`${line.slice(0, 400)}…`);
  });
});

describe('namedByWarning', () => {
  const warnings = [
    { code: 'carries-scripts', text: 'This skill carries a script a ferret may run: run.sh. Read it.' },
    { code: 'unpinned-package', text: 'npx fetches big.txt newest.' },
  ];
  it('is true for a file a reading warning names', () => {
    should(namedByWarning('run.sh', warnings)).equal(true);
  });
  it('is false for a file no warning names, and for a warning that is not about reading', () => {
    should(namedByWarning('notes.md', warnings)).equal(false);
    should(namedByWarning('big.txt', warnings)).equal(false);
  });
});
