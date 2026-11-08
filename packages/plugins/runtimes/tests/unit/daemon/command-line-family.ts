/**
 * The generated family of ruling #40 — a credential NESTED inside a command-line word — shared by the Resolved view's
 * tests and the component detail's, so both reads are held to the same shapes.
 *
 * Every secret-named key spelling × every separator × every position a value takes on a command line (the word after
 * a harmless flag, glued to one by `=` or a space, stuck to a one-letter flag, a word of its own, the middle of a
 * `a=1,KEY=v,b=2` list) × quoting × the line ending there or going on; and the same for a URL's user password and its
 * secret-named query parameters. Each secret must be gone, while the key, the flag, the user, the host and every
 * other parameter stay; each control (a harmless key, a pointer, a value too short to be a secret) is exact.
 *
 * Also the oracle the differentials share: what "hides at least what today hides" means for one word and one line.
 *
 * Every secret here is an obviously fake one.
 */

export const HIDDEN = '‹hidden›';

const FAKE = 'not-a-real-secret-0000';

/** One generated command line, and what must and must not be shown of its word at `at`. */
export interface NestedCase {
  readonly label: string;
  readonly words: readonly string[];
  /** The index of the word that holds the nested value. */
  readonly at: number;
  readonly secret: boolean;
  /** What must not be shown, anywhere, when `secret`. */
  readonly body: string;
  /** What must still be shown of that word: the flag, the key, the user and host, the other parameters. */
  readonly kept: readonly string[];
}

const SECRET_KEYS = [
  'API_KEY',
  'api_key',
  'Api-Key',
  'X-Api-Key',
  'mcp_servers.x.env.API_KEY',
  'Authorization',
  'authorization',
  'ACCESS_TOKEN',
  'password',
  'client.secret',
];
const HARMLESS_KEYS = ['model', 'X-Request-Id', 'mcp_servers.x.env.LOG_LEVEL', 'tokens', 'keyring'];
const SEPARATORS = ['=', ':', ': ', ' = '];
const VALUES: readonly { readonly value: string; readonly secret: boolean; readonly body: string }[] = [
  { value: FAKE, secret: true, body: FAKE },
  { value: `Bearer ${FAKE}`, secret: true, body: FAKE },
  { value: 'Basic bm90LWEtcmVhbC0wMDAw==', secret: true, body: 'bm90LWEtcmVhbC0wMDAw' },
  { value: '$API_TOKEN', secret: false, body: '' },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
  { value: '${secret:API_TOKEN}', secret: false, body: '' },
  { value: 'short', secret: false, body: '' },
];
const QUOTES = ['', "'", '"'];
const BEFORE = '--print';
const AFTER = '--verbose';

type Position = 'next word' | 'glued =' | 'glued space' | 'stuck' | 'own word' | 'list middle';
const POSITIONS: readonly Position[] = ['next word', 'glued =', 'glued space', 'stuck', 'own word', 'list middle'];

/** The words a nested `text` makes at `position`, the index of the one holding it, and what of it must stay. */
function placed(text: string, position: Position): { words: string[]; at: number; kept: string[] } {
  switch (position) {
    case 'next word':
      return { words: ['-c', text], at: 2, kept: [] };
    case 'glued =':
      return { words: [`--header=${text}`], at: 1, kept: ['--header='] };
    case 'glued space':
      return { words: [`--header ${text}`], at: 1, kept: ['--header '] };
    case 'stuck':
      return { words: [`-H${text}`], at: 1, kept: ['-H'] };
    case 'own word':
      return { words: [text], at: 1, kept: [] };
    default:
      return { words: [`--set=a=1,${text},b=2`], at: 1, kept: ['--set=a=1,', ',b=2'] };
  }
}

/** The nested-key family: key × separator × value × position × quoting × end of line. */
function nestedKeyCases(): NestedCase[] {
  const cases: NestedCase[] = [];
  for (const [named, keys] of [
    [true, SECRET_KEYS],
    [false, HARMLESS_KEYS],
  ] as const) {
    for (const key of keys) {
      for (const separator of SEPARATORS) {
        for (const { value, secret, body } of VALUES) {
          for (const position of POSITIONS) {
            // `-H<key> = v` is a flag `-H<key>` with a value after a space: #37's name rule, already hidden whole.
            if (position === 'stuck' && separator.startsWith(' ')) continue;
            // A list item is unquoted inside its list, and a value stuck to `-H` reaches argv with the shell's quotes
            // gone (a quote left in the word makes `-H'API_KEY` a flag of its own, which #37's name rule already hides).
            for (const quote of position === 'list middle' || position === 'stuck' ? [''] : QUOTES) {
              for (const last of [true, false]) {
                const text = `${quote}${key}${separator}${value}${quote}`;
                const shape = placed(text, position);
                const words = [BEFORE, ...shape.words, ...(last ? [] : [AFTER])];
                cases.push({
                  label: JSON.stringify(words),
                  words,
                  at: shape.at,
                  secret: named && secret,
                  body,
                  kept: [...shape.kept, `${key}${separator.trimEnd()}`],
                });
              }
            }
          }
        }
      }
    }
  }
  return cases;
}

const SCHEMES = ['https', 'postgres', 'git+ssh'];
const URL_POSITIONS: readonly Position[] = ['next word', 'glued =', 'glued space', 'own word'];

/** The URL family: a user's password and a secret-named query parameter, in every position and quoting. */
function urlCases(): NestedCase[] {
  const shapes: { text: (scheme: string) => string; secret: boolean; body: string; kept: string[] }[] = [
    {
      text: s => `${s}://person:${FAKE}@db.example.invalid/x`,
      secret: true,
      body: FAKE,
      kept: ['person:', '@db.example.invalid/x'],
    },
    {
      text: s => `${s}://person:pw@db.example.invalid`,
      secret: true,
      body: ':pw@',
      kept: ['person:', '@db.example.invalid'],
    },
    { text: s => `${s}://:${FAKE}@db.example.invalid`, secret: true, body: FAKE, kept: ['@db.example.invalid'] },
    {
      text: s => `${s}://h.example.invalid/x?token=${FAKE}&model=m`,
      secret: true,
      body: FAKE,
      kept: ['h.example.invalid/x?token=', '&model=m'],
    },
    { text: s => `${s}://h.example.invalid/x?a=1&api_key=${FAKE}`, secret: true, body: FAKE, kept: ['?a=1&api_key='] },
    { text: s => `${s}://h.example.invalid/x?model=m&page=2`, secret: false, body: '', kept: [] },
    { text: s => `${s}://person@h.example.invalid/x`, secret: false, body: '', kept: [] },
    { text: s => `${s}://person:$DB_PASSWORD@h.example.invalid`, secret: false, body: '', kept: [] },
    { text: s => `${s}://h.example.invalid/x?token=short`, secret: false, body: '', kept: [] },
  ];
  const cases: NestedCase[] = [];
  for (const scheme of SCHEMES) {
    for (const shape of shapes) {
      for (const position of URL_POSITIONS) {
        for (const quote of QUOTES) {
          for (const last of [true, false]) {
            const placedShape = placed(`${quote}${shape.text(scheme)}${quote}`, position);
            const words = [BEFORE, ...placedShape.words, ...(last ? [] : [AFTER])];
            cases.push({
              label: JSON.stringify(words),
              words,
              at: placedShape.at,
              secret: shape.secret,
              body: shape.body,
              kept: [...placedShape.kept, `${scheme}://`, ...shape.kept],
            });
          }
        }
      }
    }
  }
  return cases;
}

/** Every generated case of ruling #40. */
export const nestedFamily = (): readonly NestedCase[] => [...nestedKeyCases(), ...urlCases()];

/** What is wrong with what was shown, word by word, for one case; or nothing. */
export function nestedBreach(
  family: NestedCase,
  shown: readonly { readonly value: string; readonly hidden?: boolean }[],
): string | undefined {
  if (shown.length !== family.words.length) return `${family.label}: ${String(shown.length)} words shown`;
  for (const [index, word] of family.words.entries()) {
    if (index === family.at && family.secret) continue;
    if (shown[index]?.value !== word || shown[index]?.hidden === true) return `${family.label}: changed ${word}`;
  }
  if (!family.secret) return undefined;
  const value = shown[family.at]?.value ?? '';
  if (shown.some(word => word.value.includes(family.body))) return `${family.label}: shows ${family.body}`;
  if (shown[family.at]?.hidden !== true) return `${family.label}: not marked hidden`;
  if (!value.includes(HIDDEN)) return `${family.label}: no ${HIDDEN}`;
  const lost = family.kept.find(part => !value.includes(part));
  return lost === undefined ? undefined : `${family.label}: lost ${lost}`;
}

/** The same, for an MCP server's line `<command> <words…>`. */
export function nestedLineBreach(family: NestedCase, command: string, line: string): string | undefined {
  const written = [command, ...family.words].join(' ');
  if (!family.secret) return line === written ? undefined : `${family.label}: changed`;
  if (line.includes(family.body)) return `${family.label}: shows ${family.body}`;
  if (!line.startsWith(`${command} ${BEFORE} `)) return `${family.label}: lost its start`;
  if (family.words.at(-1) === AFTER && !line.endsWith(` ${AFTER}`)) return `${family.label}: lost ${AFTER}`;
  const lost = family.kept.find(part => !line.includes(part));
  return lost === undefined ? undefined : `${family.label}: lost ${lost}`;
}

// ── The oracle ───────────────────────────────────────────────────────────────────────────────────

/**
 * Whether `five` shows nothing `today` hides: with no cut it equals today; with cuts, the first piece starts today,
 * the last ends it, and every piece stands in order in today with something cut before it.
 */
export function lineHidesAtLeast(today: string, five: string): boolean {
  const pieces = five.split(HIDDEN);
  const first = pieces[0] ?? '';
  const last = pieces.at(-1) ?? '';
  if (pieces.length === 1) return today === five;
  if (!today.startsWith(first) || !today.endsWith(last)) return false;
  let from = first.length;
  for (const piece of pieces.slice(1, -1)) {
    const at = today.indexOf(piece, from + 1);
    if (at < 0) return false;
    from = at + piece.length;
  }
  return today.length - last.length > from;
}

export interface Shown {
  readonly value: string;
  readonly hidden?: true;
}

/**
 * Whether `five` shows nothing of `word` that `today` hides: today's hidden word stays hidden, and every cut stands
 * for some of the word's own bytes, in order — at its end (`--token=‹hidden›`) or inside it, where a nested key or a
 * URL's password is cut and what follows is kept (ruling #40: `a=1,api_key=‹hidden›,b=2`, `https://u:‹hidden›@host`).
 */
export function hidesAtLeast(word: string, today: Shown, five: Shown): boolean {
  if (today.hidden === true) return five.hidden === true && five.value === HIDDEN;
  if (five.hidden !== true) return five.value === word;
  return five.value.includes(HIDDEN) && lineHidesAtLeast(word, five.value);
}
