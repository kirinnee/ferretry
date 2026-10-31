import { describe, it } from 'bun:test';
import type { CatalogInstallWarningCode } from '@ferretry/protocol';
import should from 'should';
import {
  fingerprintStart,
  formatBytes,
  holdsMarker,
  placeholderName,
  plural,
  reviewHeading,
  reviewRows,
  shortDigest,
  splitMarkers,
  warningRows,
} from '../../../../src/features/catalogs/catalog-review-model.ts';

const RLO = `${String.fromCodePoint(0x27e8)}U+202E${String.fromCodePoint(0x27e9)}`;

describe('markers', () => {
  it('splits text around each marker and rejoins to the input', () => {
    const text = `before ${RLO} after ${RLO}`;
    const segments = splitMarkers(text);
    should(segments.map(segment => segment.marker)).eql([false, true, false, true]);
    should(segments.map(segment => segment.text).join('')).equal(text);
  });
  it('treats plain text as one segment and empty text as none', () => {
    should(splitMarkers('plain')).eql([{ marker: false, text: 'plain' }]);
    should(splitMarkers('')).eql([]);
  });
  it('starts with a marker', () => {
    should(splitMarkers(RLO)).eql([{ marker: true, text: RLO }]);
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
    should(rows[0]).eql({ kind: 'file', path: 'SKILL.md', text: 'one\ntwo', lines: 2, marked: false });
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
    should(fingerprintStart('fy_daemon_q3XkAAAA')).equal('fy_daemon_q3Xk…');
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
