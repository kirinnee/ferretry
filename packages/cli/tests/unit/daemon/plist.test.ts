import { describe, it } from 'bun:test';
import should from 'should';
import { isBinaryPlist, parsePlist, plistString } from '../../../src/lib/daemon/plist';

describe('reading an XML property list', () => {
  it('should read the scalar elements of a bare value', () => {
    // Act + Assert
    should(parsePlist('<string>a &amp; b</string>')).eql({ kind: 'string', value: 'a & b' });
    should(parsePlist('<integer> 42 </integer>')).eql({ kind: 'number', value: 42 });
    should(parsePlist('<real>1.5</real>')).eql({ kind: 'number', value: 1.5 });
    should(parsePlist('<date>2026-01-01T00:00:00Z</date>')).eql({ kind: 'string', value: '2026-01-01T00:00:00Z' });
  });

  it('should read the self-closing forms launchd writes for booleans and empty containers', () => {
    // Act + Assert
    should(parsePlist('<true/>')).eql({ kind: 'boolean', value: true });
    should(parsePlist('<false/>')).eql({ kind: 'boolean', value: false });
    should(parsePlist('<string/>')).eql({ kind: 'string', value: '' });
    should(parsePlist('<data/>')).eql({ kind: 'string', value: '' });
    should(parsePlist('<date/>')).eql({ kind: 'string', value: '' });
    should(parsePlist('<array/>')).eql({ kind: 'array', items: [] });
    should(parsePlist('<dict/>')).eql({ kind: 'dict', entries: new Map() });
  });

  it('should read an empty dictionary nested inside a wrapped plist', () => {
    // Arrange
    const xml = '<plist version="1.0"><dict><key>EnvironmentVariables</key><dict/></dict></plist>';

    // Act
    const actual = parsePlist(xml);

    // Assert
    should(actual).eql({
      kind: 'dict',
      entries: new Map([['EnvironmentVariables', { kind: 'dict', entries: new Map() }]]),
    });
  });

  it('should answer undefined for an element that is not a plist value', () => {
    // Act + Assert
    should(parsePlist('<foo>bar</foo>')).be.undefined();
    should(parsePlist('<foo/>')).be.undefined();
    should(parsePlist('<plist><foo>bar</foo></plist>')).be.undefined();
    should(parsePlist('<dict><key>A</key><foo>bar</foo></dict>')).be.undefined();
  });

  it('should answer undefined for a text element that is never closed properly', () => {
    // Act + Assert
    should(parsePlist('<string>unterminated')).be.undefined();
    should(parsePlist('<string>a<b/>c</string>')).be.undefined();
    should(parsePlist('<string>a</data>')).be.undefined();
    should(parsePlist('<dict><key>A')).be.undefined();
  });

  it('should answer undefined for a number that is not one', () => {
    // Act + Assert
    should(parsePlist('<integer>seven</integer>')).be.undefined();
    should(parsePlist('<real></real>')).be.undefined();
    should(parsePlist('<integer>   </integer>')).be.undefined();
    should(parsePlist('<integer>4</integer>trailing')).be.undefined();
  });

  it('should answer undefined for a dictionary whose entries are malformed', () => {
    // Act + Assert
    should(parsePlist('<dict><string>no key</string></dict>')).be.undefined();
    should(parsePlist('<dict><key>A</key></dict>')).be.undefined();
    should(parsePlist('<dict><key>A</key><string>x</string></array>')).be.undefined();
    should(parsePlist('<array><string>x</string></dict>')).be.undefined();
  });

  it('should name a binary property list so the caller can convert it first', () => {
    // Act + Assert
    should(isBinaryPlist('bplist00\u0001')).be.true();
    should(isBinaryPlist('<plist/>')).be.false();
  });
});

describe('reaching into a parsed property list', () => {
  const root = parsePlist(
    '<plist><dict><key>Label</key><string>com.ferretry.fyd</string><key>Env</key><dict><key>HOME</key><string>/h</string><key>N</key><integer>1</integer></dict></dict></plist>',
  );

  it('should return the string at a nested path', () => {
    // Act + Assert
    should(plistString(root, 'Label')).equal('com.ferretry.fyd');
    should(plistString(root, 'Env', 'HOME')).equal('/h');
  });

  it('should return undefined for a missing step, a non-dictionary step or a non-string leaf', () => {
    // Act + Assert
    should(plistString(root, 'Missing')).be.undefined();
    should(plistString(root, 'Label', 'Deeper')).be.undefined();
    should(plistString(root, 'Env', 'N')).be.undefined();
    should(plistString(root, 'Env')).be.undefined();
    should(plistString(undefined, 'Label')).be.undefined();
  });
});
