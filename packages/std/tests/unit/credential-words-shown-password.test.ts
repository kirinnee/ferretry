// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every case is the literal text of a shell reference, `${X:-lit}`.
/**
 * The four classes of a password the word cutter once SHOWED on a command line (ports-pending runtimes, the `-p` GAP),
 * all older than the `-p<password>` fix, each now hidden and each pinned both ways: the shape that must be cut, and the
 * look-alike that points at a variable (or is too short to be a credential) and must stay as written.
 *
 * 1. clustered short flags: `-vp<password>`, `-xp<password>`, `-Np`, `-Bp`, `-Cp`, `-Ep`, `-Vp`, `-dp`, `-lp` (mysql and
 *    mysqldump read the letters before the `p` as flags);
 * 2. a separator right after the letter: `-p=<password>`, `-p-<password>` (the separator is the password's first character);
 * 3. a default literal inside `${X:-lit}`: the literal is a value, not a reference;
 * 4. a single-quoted `'$Literal'`: a shell expands nothing in single quotes, so the text is a value.
 *
 * Fake only: every value is shaped like a credential and is none.
 */
import { describe, expect, test } from 'bun:test';
import {
  HIDDEN_VALUE_TEXT,
  looksSecret,
  pointsElsewhere,
  shownWord,
  shownWords,
} from '../../src/credential-words/index.ts';

const HIDDEN = HIDDEN_VALUE_TEXT;
const PASSWORD = 'abcdefgh12';

const shown = (word: string, before?: string): string => shownWord(word, before).text;
const shownAll = (...words: readonly string[]): readonly string[] => shownWords(words).map(word => word.text);

describe('clustered short flags: the letters before the p are flags, the rest is the password', () => {
  test.each([
    ['-vp', `-vp${PASSWORD}`],
    ['-xp', `-xp${PASSWORD}`],
    ['-vxp', `-vxp${PASSWORD}`],
  ])('should hide the password of %s and keep the flags', (flags, word) => {
    // Act
    const actual = shownWord(word, undefined);

    // Assert
    expect(actual).toEqual({ text: `${flags}${HIDDEN}`, hidden: true });
    expect(actual.text).not.toContain(PASSWORD);
  });

  test('should hide a quoted password with a blank in it after a cluster', () => {
    expect(shown(`-vp'a b c'`)).toBe(`-vp${HIDDEN}`);
  });

  test('should hide it inside a whole command line, the words around it untouched', () => {
    expect(shownAll('mysql', '-u', 'root', `-vp${PASSWORD}`, 'db')).toEqual([
      'mysql',
      '-u',
      'root',
      `-vp${HIDDEN}`,
      'db',
    ]);
  });

  test.each([
    '-vp$DB_PASSWORD',
    '-xp${DB_PASSWORD}',
    '-vp"$DB_PASSWORD"',
    '-vpshort',
    '-vp',
    '-v',
    '-vvv',
    '-xvf',
    '-vxs',
    '-vpa',
  ])('should keep %s as written: a pointer, too short, or no p at all', word => {
    expect(shown(word)).toBe(word);
  });

  test('should keep a letter that is not the password letter as a flag, never read as a cluster', () => {
    expect(shown(`-vP${PASSWORD}`)).toBe(`-vP${PASSWORD}`);
    expect(shown(`-vk${PASSWORD}`)).toBe(`-vk${PASSWORD}`);
  });

  test.each([
    '-hproxy.example.com',
    '-uprod_user_01',
    '-eapiKey=short',
    '-Happ_key=short',
    '-Dspring.profiles=prod',
    '-vhpostgres.internal',
  ])('should keep %s as written: a letter that takes a value ends the cluster, so there is no -p flag in it', word => {
    expect(shown(word)).toBe(word);
  });
});

describe('a separator after the p: the `=` or `-` is the password`s first character, not the flag`s', () => {
  test.each([
    ['-p=', `-p=${PASSWORD}`],
    ['-p-', `-p-${PASSWORD}`],
    ['-vp=', `-vp=${PASSWORD}`],
    ['-xp-', `-xp-${PASSWORD}`],
  ])('should hide the password of %s', (head, word) => {
    // Act
    const actual = shownWord(word, undefined);

    // Assert
    expect(actual.hidden).toBe(true);
    expect(actual.text).toBe(`${head.slice(0, head.length - 1)}${HIDDEN}`);
    expect(actual.text).not.toContain(PASSWORD);
  });

  test.each([
    '-p=$DB_PASSWORD',
    '-p=${DB_PASSWORD}',
    '-p-$DB_PASSWORD',
    '-vp=${DB_PASSWORD}',
    '-p=',
    '-p-',
    '-p=ab',
    '-p-ab',
  ])('should keep %s as written: a pointer after the separator, nothing, or too short', word => {
    expect(shown(word)).toBe(word);
  });

  test('should not read a long flag as a -p flag: --password=… is the long flag`s own', () => {
    expect(shown('--password=$DB_PASSWORD')).toBe('--password=$DB_PASSWORD');
    expect(shown(`--password=${PASSWORD}`)).toBe(`--password=${HIDDEN}`);
    expect(shown('--p-name=abcdefgh12')).toBe('--p-name=abcdefgh12');
  });
});

describe('a default literal inside ${X:-lit} is a value, not a reference', () => {
  test.each([
    ['-p${DB:-hunter2hunter2}', `-p${HIDDEN}`],
    ['--password=${X:-lit}', `--password=${HIDDEN}`],
    ['--password=${X:-hunter2hunter2}', `--password=${HIDDEN}`],
    ['--password=${X-hunter2hunter2}', `--password=${HIDDEN}`],
    ['--password=${X:=hunter2hunter2}', `--password=${HIDDEN}`],
    ['--password=${X=hunter2hunter2}', `--password=${HIDDEN}`],
    ['--password=${X:+hunter2hunter2}', `--password=${HIDDEN}`],
    ['--password=${X:?hunter2hunter2}', `--password=${HIDDEN}`],
    ['--password=${X:-$Y:hunter2}', `--password=${HIDDEN}`],
    ['--password=${X:-${Y:-hunter2hunter2}}', `--password=${HIDDEN}`],
    ['--password="${X:-hunter2hunter2}"', `--password=${HIDDEN}`],
    ['-vp${DB:-hunter2hunter2}', `-vp${HIDDEN}`],
    ['-p=${DB:-hunter2hunter2}', `-p${HIDDEN}`],
  ])('should hide %s', (word, expected) => {
    // Act
    const actual = shownWord(word, undefined);

    // Assert
    expect(actual).toEqual({ text: expected, hidden: true });
    expect(actual.text).not.toContain('hunter2');
  });

  test('should hide the default literal of a value that follows a credential flag as a word of its own', () => {
    expect(shownAll('--password', '${X:-hunter2hunter2}')).toEqual(['--password', HIDDEN]);
    expect(shownAll('--token', '${X:-hunter2hunter2}')).toEqual(['--token', HIDDEN]);
  });

  test('should hide the default literal in a nested key too: API_KEY=${X:-lit}', () => {
    expect(shown('API_KEY=${X:-hunter2hunter2}')).toBe(`API_KEY=${HIDDEN}`);
    expect(shown('--set=api_key=${X:-hunter2hunter2}')).toBe(`--set=api_key=${HIDDEN}`);
    expect(shown('--header=Authorization: Bearer ${X:-hunter2hunter2}')).toBe(`--header=Authorization: ${HIDDEN}`);
  });

  test.each([
    '-p${DB_PASSWORD}',
    '-p$DB_PASSWORD',
    '--password=$DB_PASSWORD',
    '--password=${DB_PASSWORD}',
    '--password=${DB_PASSWORD:-}',
    '--password=${DB_PASSWORD:-$OTHER_PASSWORD}',
    '--password=${DB_PASSWORD-${OTHER_PASSWORD}}',
    '--password=${DB_PASSWORD:?}',
    '--password="${DB_PASSWORD}"',
    '--password=${secret:DB_PASSWORD}',
    '-p${secret:DB_PASSWORD}',
    'API_KEY=${DB_PASSWORD}',
    'API_KEY=${DB_PASSWORD:-$OTHER_PASSWORD}',
    '--env=${API_TOKEN:-default-value}',
  ])('should keep %s as written: a reference to a variable, or a default that is itself one', word => {
    expect(shown(word)).toBe(word);
  });

  test('should read the same way in the fleet`s own word tests', () => {
    expect(pointsElsewhere('${X}')).toBe(true);
    expect(pointsElsewhere('${X:-}')).toBe(true);
    expect(pointsElsewhere('${X:-$Y}')).toBe(true);
    expect(pointsElsewhere('${X:-lit}')).toBe(false);
    expect(pointsElsewhere('${X:-${Y:-lit}}')).toBe(false);
    expect(pointsElsewhere('${X}${Y}')).toBe(false);
    expect(looksSecret('DB_PASSWORD', '${X:-hunter2hunter2}')).toBe(true);
    expect(looksSecret('DB_PASSWORD', '${X:-$Y}')).toBe(false);
  });
});

describe('a single-quoted $word is a value: a shell expands nothing in single quotes', () => {
  test.each([
    ["-p'$Summer2024'", `-p${HIDDEN}`],
    ["--password='$Lit2024x'", `--password=${HIDDEN}`],
    ["--token='$API_TOKEN'", `--token=${HIDDEN}`],
    ["-vp'$Summer2024'", `-vp${HIDDEN}`],
    ["-p='$Summer2024'", `-p${HIDDEN}`],
    ["--password='${DB_PASSWORD}'", `--password=${HIDDEN}`],
    ["-password='$Lit2024x'", `-p${HIDDEN}`],
  ])('should hide %s', (word, expected) => {
    // Act
    const actual = shownWord(word, undefined);

    // Assert
    expect(actual).toEqual({ text: expected, hidden: true });
    expect(actual.text).not.toMatch(/Summer2024|Lit2024x|API_TOKEN|DB_PASSWORD/u);
  });

  test('should hide a single-quoted $word that is the word after a credential flag', () => {
    expect(shownAll('--password', "'$Lit2024x'")).toEqual(['--password', HIDDEN]);
  });

  test('should hide a single-quoted $word in a nested key, with or without a pointer beside it', () => {
    expect(shown("API_KEY='$Lit2024x'")).toBe(`API_KEY=${HIDDEN}`);
    expect(shown("--set=api_key='$Lit2024x'")).toBe(`--set=api_key=${HIDDEN}`);
    expect(shown("API_KEY='$LONG_POINTER_NAME' ${secret:OTHER_TOKEN}")).toBe(`API_KEY=${HIDDEN}`);
  });

  test.each([
    '-p"$Summer2024"',
    '--password="$Lit2024x"',
    '--password="${DB_PASSWORD}"',
    '-p"${DB_PASSWORD}"',
    '--password=$Lit2024x',
    "-p'$X'",
    "--password='$X'",
    "--password='$Lit1'",
    "--password='${secret:DB_PASSWORD}'",
    "-p'${secret:DB_PASSWORD}'",
    "API_KEY='${secret:DB_PASSWORD}'",
    'API_KEY="$LONG_POINTER_NAME" ${secret:OTHER_TOKEN}',
  ])('should keep %s as written: expanded by a shell, too short, or a Ferretry pointer', word => {
    expect(shown(word)).toBe(word);
  });
});

describe('a cluster of mysql and mysqldump switches in front of the p', () => {
  test.each(['-Np', '-Bp', '-Cp', '-Ep', '-Vp', '-dp', '-lp', '-NBp', '-vNBp'])(
    'should hide the password of %s<value> and keep the flags',
    flags => {
      // Arrange
      const word = `${flags}${PASSWORD}`;

      // Act
      const actual = shownWord(word, undefined);

      // Assert
      expect(actual).toEqual({ text: `${flags}${HIDDEN}`, hidden: true });
      expect(actual.text).not.toContain(PASSWORD);
    },
  );

  // A letter that takes a value ends the cluster (it takes the rest of the word), so those words hold no `-p` flag.
  test.each([`-hproxy.example.com`, `-uprod_user`, `-eapiKey=v`, `-DNp${PASSWORD}`, `-hNp${PASSWORD}`])(
    'should keep %s as written: a value-taking letter swallows the rest of the word',
    word => {
      // Act
      const actual = shownWord(word, undefined);

      // Assert
      expect(actual).toEqual({ text: word, hidden: false });
    },
  );
});
