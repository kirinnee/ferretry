// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every case is the literal text of a shell-style reference.
/**
 * The write rule judges a shell default's LITERAL alone (docs/config-files.md): `${NAME<op>literal}` is read for the
 * literal, with the same tests as any value, whatever the NAME is. An empty literal, a `:?` message and a path are no
 * secret under a credential key, and a random literal is one under a NAME too long and plain to dilute it. `$NAME`,
 * `${NAME}`, `${secret:NAME}` and `${secret?:NAME}` stay pure pointers. Fixtures are assembled at run time.
 */
import { describe, expect, test } from 'bun:test';
import {
  isShellPointer,
  judgedText,
  looksLikeRawSecret,
  parseShellReference,
} from '../../src/credential-words/index.ts';

const RANDOM = 'q8Zk3Vb7Xn2Mw9Lp4Rt6Yh1Jd';
const filler = (length: number): string => 'A1b2C3d4E5f6'.repeat(Math.ceil(length / 12)).slice(0, length);

describe('write rule: a shell default is judged by its literal alone', () => {
  test.each([
    ['empty default :-', '${OPENAI_API_KEY:-}'],
    ['empty default -', '${OPENAI_API_KEY-}'],
    ['empty default :=', '${OPENAI_API_KEY:=}'],
    ['empty default =', '${OPENAI_API_KEY=}'],
    ['empty alternate :+', '${OPENAI_API_KEY:+}'],
    ['empty alternate +', '${OPENAI_API_KEY+}'],
    ['required :?msg', '${OPENAI_API_KEY:?required}'],
    ['required ? with a long message', `\${OPENAI_API_KEY?${RANDOM}}`],
    ['required :? with a long message', `\${OPENAI_API_KEY:?${RANDOM}}`],
    ['a path default', '${TLS_KEY:-/etc/ssl/private/key.pem}'],
    ['a URL default', '${JWKS_TOKEN:-https://example.com/.well-known/jwks.json}'],
    ['a short default', '${API_TOKEN:-changeme}'],
    ['a default that is a pointer', '${API_KEY:-${secret:API_KEY}}'],
    ['a default that is a $NAME', '${API_KEY:-$OTHER_KEY_NAME_THAT_IS_LONG}'],
    ['a default that is itself an empty default', '${API_KEY:-${OTHER_KEY:-}}'],
    ['a pointer, braces', '${OPENAI_API_KEY_WITH_A_LONG_NAME}'],
    ['a pointer, bare', '$OPENAI_API_KEY_WITH_A_LONG_NAME'],
    ['a secret pointer', '${secret:OPENAI_API_KEY_WITH_A_LONG_NAME}'],
    ['an optional secret pointer', '${secret?:OPENAI_API_KEY_WITH_A_LONG_NAME}'],
  ])('should not refuse %s under a credential key', (_label, value) => {
    expect(looksLikeRawSecret('OPENAI_API_KEY', value)).toBe(false);
  });

  test.each([
    [':-', `\${X:-${RANDOM}}`],
    ['-', `\${X-${RANDOM}}`],
    [':=', `\${X:=${RANDOM}}`],
    ['=', `\${X=${RANDOM}}`],
    [':+', `\${X:+${RANDOM}}`],
    ['+', `\${X+${RANDOM}}`],
  ])('should refuse a random literal of the %s operator under a credential key', (_op, value) => {
    expect(looksLikeRawSecret('API_KEY', value)).toBe(true);
  });

  test('should refuse a random literal under a NAME so long and plain that it diluted the whole string', () => {
    // Arrange
    const value = `\${${'A'.repeat(60)}:-${RANDOM}}`;

    // Act + Assert
    expect(looksLikeRawSecret('API_KEY', value)).toBe(true);
  });

  test('should refuse a nested default by its innermost literal', () => {
    expect(looksLikeRawSecret('API_KEY', `\${A:-\${B:-${RANDOM}}}`)).toBe(true);
    expect(looksLikeRawSecret('API_KEY', `\${A:=\${B:+${RANDOM}}}`)).toBe(true);
  });

  test('should refuse a known key shape inside a default, even where the key names no credential and the op is :?', () => {
    expect(looksLikeRawSecret('HOST', `\${X:-sk-ant-${filler(20)}}`)).toBe(true);
    expect(looksLikeRawSecret('HOST', `\${X:?ghp_${filler(24)}}`)).toBe(true);
  });

  test('should judge text around a reference as the text it is', () => {
    expect(looksLikeRawSecret('API_KEY', `\${A:-x}-\${B:-${RANDOM}}`)).toBe(true);
    expect(looksLikeRawSecret('API_KEY', `\${A:-${RANDOM}`)).toBe(true);
  });

  test('should refuse a random literal nested forty defaults deep', () => {
    const deep = `${'${A:-'.repeat(40)}${RANDOM}${'}'.repeat(40)}`;
    expect(looksLikeRawSecret('API_KEY', deep)).toBe(true);
  });

  test('should leave a key that names no credential alone, whatever the default holds', () => {
    expect(looksLikeRawSecret('HOST', `\${X:-${RANDOM}}`)).toBe(false);
  });
});

describe('shell reference: one reading for the write rule and the displays', () => {
  test('should read a pointer, a default and a message', () => {
    expect(parseShellReference('${A}')).toEqual({ kind: 'pointer' });
    expect(parseShellReference('${secret?:A}')).toEqual({ kind: 'pointer' });
    expect(parseShellReference('${A:-x${B}y}')).toEqual({ kind: 'default', operator: ':-', literal: 'x${B}y' });
    expect(parseShellReference('${A?why}')).toEqual({ kind: 'default', operator: '?', literal: 'why' });
  });

  test('should read text that is not exactly one reference as none', () => {
    expect(parseShellReference('${A:-x}-${B:-y}')).toBeUndefined();
    expect(parseShellReference('${A:-x')).toBeUndefined();
    expect(parseShellReference('a${A}')).toBeUndefined();
  });

  test('should say which text a pointer or a message holds: nothing', () => {
    expect(judgedText('${A}')).toBe('');
    expect(judgedText('${A:?msg}')).toBe('');
    expect(judgedText('${A:-}')).toBe('');
    expect(judgedText('${A:-${B:-lit}}')).toBe('lit');
    expect(judgedText('plain')).toBe('plain');
    expect(isShellPointer('${A:-x}')).toBe(false);
    expect(isShellPointer('${A}')).toBe(true);
  });
});
