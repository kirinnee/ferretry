import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRedaction } from '@ferretry/core-vault/contract/testing';
import type { SecretName } from '@ferretry/core-vault/contract';
import { maskedScreen } from '../../../../../daemon/lib/session/snapshot/screen-mask.ts';

const WIDTH = 80;
/** A 213-character token, the length of a short JWT: three rows of an 80-column harness box. Fake. */
const LONG = `FAKEJWTprobe.${'x9Y8w7V6u5T4s3R2q1P0'.repeat(10)}`;
/** A 40-character token. Fake. */
const SHORT = 'ghp_FAKEBOXfixtureAAAABBBBCCCCDDDDEEEE12';
/** A password, and a longer value that holds it. Fake. */
const PASSWORD = 'FAKEpw-0f9e8d7c';
const URL = `postgres://appuser:${PASSWORD}@db-FAKEPROBE-host.internal:5432/app`;
/** A passphrase with spaces: a word-wrapping UI breaks it at a space, which capture-pane trims off the row's end. */
const PASSPHRASE = 'correct horse FAKEPROBE battery staple';

const vault = (values: Record<string, string>) =>
  new FakeRedaction(new Map(Object.entries(values).map(([name, value]) => [name as SecretName, value])));

/**
 * `value` laid out the way Claude Code (Ink) and Codex (ratatui) hard-break a word longer than their box: the first
 * row starts with `lead`, every continuation row with `indent`, each row at most `width` wide inside `right`.
 */
function hardBroken(lead: string, indent: string, value: string, right = '', width = WIDTH): string[] {
  const rows: string[] = [];
  let rest = value;
  let prefix = lead;
  while (rest.length > 0) {
    const room = width - prefix.length - right.length;
    const piece = rest.slice(0, room);
    rest = rest.slice(room);
    rows.push(
      `${prefix}${piece}${right === '' ? '' : `${piece.length < room ? ' '.repeat(room - piece.length) : ''}${right}`}`,
    );
    prefix = indent;
  }
  return rows;
}

async function mask(screen: string, values: Record<string, string>): Promise<string> {
  return await vault(values).read(scope => maskedScreen(scope, screen));
}

/** No piece of `value` 8 characters or longer survives anywhere in `out`. */
function noPieceOf(value: string, out: string): void {
  for (let at = 0; at + 8 <= value.length; at += 1) expect(out).not.toContain(value.slice(at, at + 8));
}

describe('F-0326 the screen masker: a value the harness UI wrapped inside its indent or box', () => {
  test("F-0326 a 213-character value in Claude Code's ⎿ tool result, continued under a 5-space indent, is starred in every row", async () => {
    const rows = ['⏺ Bash(echo $TOKEN)', ...hardBroken('  ⎿  ', '     ', LONG), '', '> '];
    expect(rows.length).toBe(6);
    const out = await mask(rows.join('\n'), { TOKEN: LONG });
    noPieceOf(LONG, out);
    const kept = out.split('\n');
    // Every row keeps its width and its gutter: only the value's characters became `*`.
    expect(kept.map(row => row.length)).toEqual(rows.map(row => row.length));
    expect(kept[1]?.startsWith('  ⎿  ***')).toBe(true);
    expect(kept[2]?.startsWith('     ***')).toBe(true);
    expect(kept[3]?.startsWith('     ***')).toBe(true);
    expect(kept[0]).toBe('⏺ Bash(echo $TOKEN)');
  });

  test('F-0326 a value in a reply (⏺ then a 2-space indent) is starred in both rows', async () => {
    const rows = hardBroken('⏺ Your token is ', '  ', `${SHORT}${SHORT.slice(4)}${SHORT.slice(4)}`);
    const value = `${SHORT}${SHORT.slice(4)}${SHORT.slice(4)}`;
    expect(rows.length).toBe(2);
    const out = await mask(rows.join('\n'), { TOKEN: value });
    noPieceOf(value, out);
    expect(out.split('\n')[0]?.startsWith('⏺ Your token is ****')).toBe(true);
  });

  test('F-0326 a value split across two rows of a │ … │ box is starred in both rows and the borders stay', async () => {
    const rows = [
      '╭──────────────────────────────╮',
      ...hardBroken('│ ', '│ ', SHORT, ' │', 32),
      '╰──────────────────────────────╯',
    ];
    expect(rows.length).toBe(4);
    const out = await mask(rows.join('\n'), { TOKEN: SHORT });
    noPieceOf(SHORT, out);
    expect(out.split('\n')).toEqual([
      rows[0] ?? '',
      `│ ${'*'.repeat(28)} │`,
      `│ ${'*'.repeat(SHORT.length - 28)}${' '.repeat(28 - (SHORT.length - 28))} │`,
      rows[3] ?? '',
    ]);
  });

  test("F-0326 Codex's └ tool output, continued under its indent, is starred in every row", async () => {
    const rows = ['• Ran env | grep TOKEN', ...hardBroken('  └ TOKEN=', '    ', LONG)];
    const out = await mask(rows.join('\n'), { TOKEN: LONG });
    noPieceOf(LONG, out);
    expect(out.split('\n')[1]?.startsWith('  └ TOKEN=***')).toBe(true);
  });

  test('F-0326 a value tmux wrapped at the pane edge (no gutter) is still starred in both rows', async () => {
    const rows = [`${'x'.repeat(60)}${SHORT.slice(0, 20)}`, `${SHORT.slice(20)} and the rest`];
    const out = await mask(rows.join('\n'), { TOKEN: SHORT });
    expect(out.split('\n')).toEqual([
      `${'x'.repeat(60)}${'*'.repeat(20)}`,
      `${'*'.repeat(SHORT.length - 20)} and the rest`,
    ]);
  });

  test('F-0326 a value that stands whole in one row keeps its [redacted:NAME] marker', async () => {
    const out = await mask(`plain ${SHORT} here\n> `, { GH_TOKEN: SHORT });
    expect(out).toBe('plain [redacted:GH_TOKEN] here\n> ');
  });

  test('F-0326 a longer wrapped value that holds a shorter vault value leaks none of its rest', async () => {
    // The password stands whole in the first row and the URL that holds it wraps: a text pass run first would turn
    // the password into its marker and leave the rest of the URL unmatchable.
    const rows = hardBroken('  ⎿  DATABASE_URL=', '     ', URL, '', 60);
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain(PASSWORD);
    const out = await mask(rows.join('\n'), { PW: PASSWORD, DATABASE_URL: URL });
    noPieceOf(URL, out);
    expect(out).not.toContain('postgres://appuser:');
    expect(out).not.toContain('@db-FAKEPROBE-host.internal:5432/app');
  });

  test('F-0326 a value broken at a space that capture-pane trimmed off the row end is starred in both rows', async () => {
    // Word-wrapped after FAKEPROBE: the space is gone from the end of the first row.
    const rows = ['  ⎿  passphrase: correct horse FAKEPROBE', '     battery staple', '> '];
    const out = await mask(rows.join('\n'), { PASS: PASSPHRASE });
    expect(out).not.toContain('FAKEPROBE');
    expect(out).not.toContain('battery');
    expect(out).not.toContain('correct horse');
    expect(out.split('\n')[2]).toBe('> ');
  });

  test('F-0326 a multi-line value printed across real line breaks is masked', async () => {
    const pem = 'FAKEKEYline-one-AAAA\nFAKEKEYline-two-BBBB';
    const out = await mask(`$ cat key\n${pem}\n$ `, { KEY: pem });
    expect(out).not.toContain('FAKEKEYline');
  });

  test('F-0326 a * the screen already showed is not taken for a mask, and a row with no value is untouched', async () => {
    const screen = '**bold** text\n  ⎿  nothing secret here\n│ a box │';
    expect(await mask(screen, { TOKEN: SHORT })).toBe(screen);
  });

  test('F-0326 a masker whose lines come back another length is not trusted: the whole piece is hidden', async () => {
    const out = await new FakeRedaction(new Map()).read(scope =>
      maskedScreen({ ...scope, lines: lines => lines.map(line => `${line}!`) }, `  ⎿  ${SHORT}\n> `),
    );
    expect(out).not.toContain(SHORT.slice(0, 8));
  });
});

describe('F-0326 #U4 one screen masker for the last screen and the live look', () => {
  test('F-0326 #U4 the Ferrets and Terminals copies of screen-mask.ts are the same bytes', () => {
    const packages = join(import.meta.dir, '../../../../../../..');
    const ferrets = readFileSync(join(packages, 'core/ferrets/daemon/lib/session/snapshot/screen-mask.ts'), 'utf8');
    const terminals = readFileSync(join(packages, 'plugins/terminals/daemon/lib/tmux/screen-mask.ts'), 'utf8');
    expect(terminals).toBe(ferrets);
  });
});

describe('BG-046 a screen past the size the masker takes is refused, never cut and never passed on', () => {
  /** The most characters of one screen the masker takes (`MAX_SCREEN_CHARS`). */
  const MOST = 262_144;
  const FILLER = 'a';

  test('BG-046 a screen over the cap is refused before the scope is asked anything, saying only the sizes', async () => {
    // Arrange: a vault value stands in the screen, and the scope counts every question.
    const screen = `${SHORT}\n${FILLER.repeat(MOST)}`;
    let asked = 0;

    // Act
    const refused = await vault({ TOKEN: SHORT })
      .read(scope =>
        maskedScreen(
          {
            ...scope,
            text: text => {
              asked += 1;
              return scope.text(text);
            },
            lines: lines => {
              asked += 1;
              return scope.lines(lines);
            },
          },
          screen,
        ),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Assert: refused whole (nothing masked, nothing cut), with a sentence that carries no character of the screen.
    expect(refused).toBeInstanceOf(RangeError);
    expect(asked).toBe(0);
    const sentence = (refused as RangeError).message;
    expect(sentence).toContain(String(screen.length));
    expect(sentence).not.toContain(SHORT);
    expect(sentence).not.toContain(FILLER.repeat(8));
  });

  test('BG-046 a screen of exactly the cap is still masked', async () => {
    // Arrange
    const screen = `${SHORT}${FILLER.repeat(MOST - SHORT.length)}`;
    expect(screen.length).toBe(MOST);

    // Act
    const out = await vault({ TOKEN: SHORT }).read(scope => maskedScreen(scope, screen));

    // Assert
    expect(out).not.toContain(SHORT);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('F-0326 #U4 the masker stays inside the stop bound on a big, busy screen', () => {
  /** A 4-character value printed densely across a 200×1300 pane (just under the masker's cap): 52,000 matches. Fake. */
  const PIN = '1234';
  const busy = (row: (index: number) => string) => Array.from({ length: 200 }, (_, index) => row(index)).join('\n');

  /** `maskedScreen` over `screen`, with every character it hands the scope counted. */
  async function measured(
    screen: string,
  ): Promise<{ readonly out: string; readonly asked: number; readonly took: number }> {
    let asked = 0;
    const started = performance.now();
    const out = await vault({ PIN }).read(scope =>
      maskedScreen(
        {
          ...scope,
          text: text => {
            asked += text.length;
            return scope.text(text);
          },
          lines: lines => {
            for (const line of lines) asked += line.length;
            return scope.lines(lines);
          },
        },
        screen,
      ),
    );
    return { out, asked, took: performance.now() - started };
  }

  test('F-0326 #U4 a 200×1300 screen dense with a short value behind a gutter asks a bounded number of whole-screen readings', async () => {
    // Arrange — every other row behind Claude Code's ⎿ indent, so whole rows and content spans differ.
    const screen = busy(index => (index % 2 === 0 ? `  ⎿  ${`${PIN} `.repeat(259)}` : `${PIN} `.repeat(260)));

    // Act
    const { out, asked, took } = await measured(screen);

    // Assert — six readings, one row-by-row check and the final text: at most eight screens' worth, never more.
    expect(out).not.toContain(PIN);
    expect(asked).toBeLessThanOrEqual(8 * screen.length);
    expect(took).toBeLessThan(2000);
  });

  test('F-0326 #U4 a screen that draws no gutter reads each join once, not twice', async () => {
    // Arrange — rows that start and end with content: whole rows and content spans are the same pieces.
    const screen = busy(() => `${PIN} `.repeat(260).trimEnd());

    // Act
    const { out, asked, took } = await measured(screen);

    // Assert — three readings, the row check and the final text.
    expect(out).not.toContain(PIN);
    expect(asked).toBeLessThanOrEqual(5 * screen.length);
    expect(took).toBeLessThan(2000);
  });
});
