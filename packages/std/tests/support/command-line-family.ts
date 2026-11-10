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
 * Review r1 (r2 round) added: a key in a glued flag's OWN part (`--hdr;API_KEY:v`), a quoted value holding a `,`
 * (`API_KEY="v,v"`, F3), a URL password holding a raw `@` (F3), and a token stuck to `-H` before a nested key
 * (`-H<token> KEY=v`, `-H<token>=KEY=v`, F2), which must stay as hidden as ruling #37 left it: `-H‹hidden›`.
 *
 * Review r2 (r3 round) added: a pointer (`${secret:…}`) in the same value as a secret, after it, before it, as the
 * value of a key before or after it, and glued in front of the key (M1); a key stuck straight to a one-letter flag with
 * a second cut after it (`-eAPI_KEY=v,token=v`, M2); and a key in a glued flag's own part whose value has a pointer and
 * a second cut (`--hdr,api_key=v;y=${secret:Z};token=v`, M3). Their controls (a value composed with a pointer,
 * `Bearer ${secret:X}`) must be exact. (`prefix${secret:X}` and `${secret:X}?model=short` were controls too; CFG-LEAK-R
 * (ii) cuts text glued to a pointer, so they are cases that hide now, and `tokens` is a secret name, not a harmless key.)
 *
 * Review r3 (r4 round) added a value that holds `=` or `:` itself (N1): base64 padded by 0, 1 or 2 `=`, `Basic`
 * before it, a `user:pass` and a `user=pass`, with a pointer later in the same value, set apart by a space or `#`,
 * or as a harmless key's value. Their controls (a part that only points at one, one too short, the same values under a
 * harmless key) must be exact. Not generated: such a value AFTER a pointer (`API_KEY=${secret:X} <v>==`), a declared
 * GAP candidate of the r4 report.
 *
 * Also the oracle the differentials share: what "hides at least what today hides" means for one word and one line.
 *
 * Every secret here is an obviously fake one.
 */

export const HIDDEN = '‹hidden›';

/**
 * What a Runtimes view says instead of a word the write rule still refuses once the cutter has had its say (the net):
 * it hides the whole word, which is at least what any cutter hides. A copy of `WITHHELD_WORDS_TEXT`, pinned equal by
 * `net-views.test.ts` in the Runtimes tests (a std test may not import a plugin).
 */
export const WITHHELD = 'Not shown: this may hold a credential. Open the file at this machine to read it.';

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
  // CFG-LEAK-R (i): `tokens` was a ruling #40 control; the read mask now reads names as the write rule does, by their tail.
  'tokens',
];
const HARMLESS_KEYS = ['model', 'X-Request-Id', 'mcp_servers.x.env.LOG_LEVEL', 'keyring'];
const SEPARATORS = ['=', ':', ': ', ' = '];
const VALUES: readonly { readonly value: string; readonly secret: boolean; readonly body: string }[] = [
  { value: FAKE, secret: true, body: FAKE },
  { value: `Bearer ${FAKE}`, secret: true, body: FAKE },
  { value: 'Basic bm90LWEtcmVhbC0wMDAw==', secret: true, body: 'bm90LWEtcmVhbC0wMDAw' },
  // A `,` inside a quoted value is the value's, not a list's (F3): both copies must go.
  { value: `"${FAKE},${FAKE}"`, secret: true, body: FAKE },
  { value: '$API_TOKEN', secret: false, body: '' },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
  { value: '${secret:API_TOKEN}', secret: false, body: '' },
  { value: 'short', secret: false, body: '' },
];
const QUOTES = ['', "'", '"'];
const BEFORE = '--print';
const AFTER = '--verbose';

type Position = 'next word' | 'glued =' | 'glued space' | 'stuck' | 'own word' | 'list middle' | 'flag part';
const POSITIONS: readonly Position[] = [
  'next word',
  'glued =',
  'glued space',
  'stuck',
  'own word',
  'list middle',
  'flag part',
];

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
    case 'flag part':
      // The key sits in the flag's own part, before any `=` or space: `--hdr;API_KEY:v`, `--hdr;API_KEY: Bearer v`.
      return { words: [`--hdr;${text}`], at: 1, kept: ['--hdr;'] };
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
            // `-H<key> = v` and `--hdr;<key> = v` are a flag with a value after a space: #37's name rule, already hidden
            // whole.
            if ((position === 'stuck' || position === 'flag part') && separator.startsWith(' ')) continue;
            // A list item is unquoted inside its list, and a value stuck to `-H` reaches argv with the shell's quotes
            // gone (a quote left in the word makes `-H'API_KEY` a flag of its own, which #37's name rule already hides).
            for (const quote of position === 'list middle' || position === 'stuck' || position === 'flag part'
              ? ['']
              : QUOTES) {
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
    // A raw `@` in the password: it runs to the LAST `@` before the host (F3).
    {
      text: s => `${s}://person:p@ss${FAKE}@db.example.invalid/x`,
      secret: true,
      body: FAKE,
      kept: ['person:', '@db.example.invalid/x'],
    },
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

const STUCK_TOKEN = 'sk-not-a-real-key-0000';

/**
 * A token stuck to `-H` and then a nested key, glued by a space or `=` (F2): ruling #37 hid the whole value
 * (`-H‹hidden›`), so every key, separator and value here — harmless or not, a pointer or not — must keep it hidden.
 */
function stuckTokenCases(): NestedCase[] {
  const cases: NestedCase[] = [];
  for (const key of [...SECRET_KEYS, ...HARMLESS_KEYS]) {
    for (const separator of SEPARATORS) {
      for (const { value } of VALUES) {
        for (const join of [' ', '=']) {
          for (const last of [true, false]) {
            const words = [BEFORE, `-H${STUCK_TOKEN}${join}${key}${separator}${value}`, ...(last ? [] : [AFTER])];
            cases.push({ label: JSON.stringify(words), words, at: 1, secret: true, body: STUCK_TOKEN, kept: ['-H'] });
          }
        }
      }
    }
  }
  return cases;
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
const POINTER = '${secret:OTHER_TOKEN}';
const POINTER_KEYS = ['API_KEY', 'X-Api-Key', 'Authorization', 'mcp_servers.x.env.ACCESS_TOKEN', 'client.secret'];
const POINTER_VALUES = [FAKE, `Bearer ${FAKE}`, `"${FAKE},${FAKE}"`];
const POINTER_POSITIONS: readonly Position[] = ['next word', 'glued =', 'stuck', 'own word', 'list middle'];

/**
 * A pointer in the same value as a secret-named key's secret (review r2 M1): each arrangement, and what of it must
 * stay. The pointer hides nothing that is set apart from it, and the key and every pointer stay.
 */
const POINTER_ARRANGEMENTS: readonly ((
  key: string,
  value: string,
) => { text: string; kept: string[]; glued?: true })[] = [
  (key, value) => ({ text: `${key}${value} ${POINTER}`, kept: [] }),
  (key, value) => ({ text: `${key}${value}#${POINTER}`, kept: [] }),
  (key, value) => ({ text: `${key}${POINTER} ${value}`, kept: [] }),
  (key, value) => ({ text: `LOG_LEVEL=${POINTER} ${key}${value}`, kept: [`LOG_LEVEL=${POINTER} `] }),
  (key, value) => ({ text: `OTHER_TOKEN=${POINTER} ${key}${value}`, kept: [`OTHER_TOKEN=${POINTER} `] }),
  (key, value) => ({ text: `${key}${value} LOG_LEVEL=${POINTER}`, kept: [` LOG_LEVEL=${POINTER}`] }),
  // The query is glued to the pointer, so the whole value of `password=` is cut, its `?KEY=` too (CFG-LEAK-R ii).
  (key, value) => ({ text: `password=${POINTER}?${key}${value}`, kept: ['password='], glued: true }),
];

/** Values composed with a pointer, or set apart from one by a harmless key: each IS no secret, and is shown exactly. */
const POINTER_CONTROLS: readonly ((key: string) => string)[] = [
  key => `${key}Bearer ${POINTER}`,
  key => `${key}${POINTER} ${POINTER}`,
  key => `${key}"${POINTER}"`,
  () => `LOG_LEVEL=${POINTER} model=${FAKE}`,
];

/**
 * Text glued to a pointer (CFG-LEAK-R ii): once ruling #40 controls shown as written, now each is cut from the start of
 * its value, and `body` is the raw text that must not be shown.
 */
const GLUED_POINTERS: readonly { readonly text: (key: string) => string; readonly body: string }[] = [
  { text: key => `${key}prefix${POINTER}`, body: 'prefix' },
  { text: key => `${key}${POINTER}?model=short`, body: 'model=short' },
  { text: key => `${key}Bearer v${POINTER}`, body: 'Bearer v' },
  // Two pointers run together are not ONE pointer: W refuses them, so the mask cuts them.
  { text: key => `${key}${POINTER}${POINTER}`, body: `${POINTER}${POINTER}` },
];

/** The pointer family (review r2 M1). */
function pointerCases(): NestedCase[] {
  const cases: NestedCase[] = [];
  const add = (
    text: string,
    position: Position,
    secret: boolean,
    kept: readonly string[],
    last: boolean,
    body = FAKE,
  ) => {
    const shape = placed(text, position);
    const words = [BEFORE, ...shape.words, ...(last ? [] : [AFTER])];
    cases.push({
      label: JSON.stringify(words),
      words,
      at: shape.at,
      secret,
      body,
      kept: [...shape.kept, ...kept],
    });
  };
  for (const key of POINTER_KEYS) {
    for (const separator of ['=', ': ']) {
      for (const position of POINTER_POSITIONS) {
        for (const last of [true, false]) {
          for (const value of POINTER_VALUES) {
            for (const arrange of POINTER_ARRANGEMENTS) {
              const { text, kept, glued } = arrange(`${key}${separator}`, value);
              // A secret key glued behind a pointer (`password=${P}?KEY=v`) is cut with that value (CFG-LEAK-R ii).
              add(text, position, true, [...(glued === true ? [] : [`${key}${separator.trimEnd()}`]), ...kept], last);
            }
          }
          for (const control of POINTER_CONTROLS) add(control(`${key}${separator}`), position, false, [], last);
          for (const glued of GLUED_POINTERS)
            add(glued.text(`${key}${separator}`), position, true, [`${key}${separator.trimEnd()}`], last, glued.body);
        }
      }
    }
  }
  return cases;
}

/**
 * A key stuck straight to a one-letter flag with a second cut after it (review r2 M2), and a key in a glued flag's own
 * part whose value has a pointer and a second cut (M3): both secrets must go, the flag and the key stay.
 */
function secondCutCases(): NestedCase[] {
  const seconds = [
    `,token=${FAKE}`,
    ` https://person:${FAKE}@h.example.invalid`,
    `, X-Api-Key: ${FAKE}`,
    `;y=${POINTER};token=${FAKE}`,
  ];
  const cases: NestedCase[] = [];
  for (const key of POINTER_KEYS) {
    for (const separator of ['=', ':', ': ']) {
      for (const value of POINTER_VALUES) {
        for (const second of seconds) {
          for (const flag of ['-e', '-H', '-c', '--hdr,', '--x&', '--set;']) {
            // A flag part's key is glued by the flag's own separator, `=` or a space.
            if (flag.startsWith('--') && separator === ':') continue;
            for (const last of [true, false]) {
              const words = [BEFORE, `${flag}${key}${separator}${value}${second}`, ...(last ? [] : [AFTER])];
              const kept = [`${flag}${key}${separator.trimEnd()}`];
              cases.push({ label: JSON.stringify(words), words, at: 1, secret: true, body: FAKE, kept });
            }
          }
        }
      }
    }
  }
  return cases;
}

/** A secret value that holds `=` or `:` (review r3 N1): base64 padding 0, 1 or 2, `Basic` before it, `user:pass`. */
const PADDED_VALUES = [
  FAKE,
  `${FAKE}=`,
  `${FAKE}==`,
  `Basic ${FAKE}`,
  `Basic ${FAKE}=`,
  `Basic ${FAKE}==`,
  `person:${FAKE}`,
  `person=${FAKE}`,
  `Basic person:${FAKE}`,
  `${FAKE}:${FAKE}==`,
];

/** A pointer LATER in the same value as a padded secret: set apart by a space, two, a `#`, or as a harmless key's. */
const LATER_POINTERS: readonly ((value: string) => { text: string; kept: string[] })[] = [
  value => ({ text: `${value} ${POINTER}`, kept: [] }),
  value => ({ text: `${value}  ${POINTER}`, kept: [] }),
  value => ({ text: `${value}#${POINTER}`, kept: [] }),
  value => ({ text: `${value} LOG_LEVEL=${POINTER}`, kept: [` LOG_LEVEL=${POINTER}`] }),
  value => ({ text: `${value} X-Trace: ${POINTER}`, kept: [` X-Trace: ${POINTER}`] }),
];

/** Before a later pointer, a part that is no secret: it points at one, or is too short; and a harmless key's value. */
const PADDED_CONTROLS: readonly ((key: string) => string)[] = [
  key => `${key}$LONG_POINTER_NAME ${POINTER}`,
  key => `${key}'$LONG_POINTER_NAME' ${POINTER}`,
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a pointer is the literal text `${NAME}`
  key => `${key}\${LONG_POINTER_NAME} ${POINTER}`,
  key => `${key}short== ${POINTER}`,
  key => `${key}a:b x=y ${POINTER}`,
  () => `LOG_LEVEL=${FAKE}== ${POINTER}`,
  () => `X-Trace: Basic person:${FAKE} ${POINTER}`,
];

/** The padded family (review r3 N1): key × separator × position × padded value × later pointer, and controls. */
function paddedCases(): NestedCase[] {
  const cases: NestedCase[] = [];
  const add = (text: string, position: Position, secret: boolean, kept: readonly string[], last: boolean) => {
    const shape = placed(text, position);
    const words = [BEFORE, ...shape.words, ...(last ? [] : [AFTER])];
    cases.push({
      label: JSON.stringify(words),
      words,
      at: shape.at,
      secret,
      body: FAKE,
      kept: [...shape.kept, ...kept],
    });
  };
  for (const key of POINTER_KEYS) {
    for (const separator of ['=', ':', ': ']) {
      for (const position of POINTER_POSITIONS) {
        for (const last of [true, false]) {
          for (const value of PADDED_VALUES) {
            for (const later of LATER_POINTERS) {
              const { text, kept } = later(value);
              add(`${key}${separator}${text}`, position, true, [`${key}${separator.trimEnd()}`, ...kept], last);
            }
          }
          for (const control of PADDED_CONTROLS) add(control(`${key}${separator}`), position, false, [], last);
        }
      }
    }
  }
  return cases;
}

/**
 * A secret-named flag's value, with a pointer on either side (review r4 B1): the flag in each form it is written in
 * (`--flag v` as two argv words or one, `--flag=v`), the value with base64 padding, `user:pass` and `Basic` before it,
 * the pointer before it, after it, between two parts of it or as a harmless key's value. The flag is read like a
 * secret-named key; a harmless flag, a one-letter one (the declared `-p<password>` GAP) and a value composed with
 * its pointer stay as written.
 */
const SECRET_FLAGS = ['--token', '--client-secret', '--api-key', '--x-api-key', '--password', '--access-token'];
const PLAIN_FLAGS = ['--model', '--verbose', '-k'];
const HARMLESS = 'harmless-value-0000';
const FLAG_VALUES = [
  FAKE,
  `${FAKE}=`,
  `${FAKE}==`,
  `Basic ${FAKE}`,
  `Basic ${FAKE}==`,
  `person:${FAKE}`,
  `Basic person:${FAKE}`,
  `${FAKE}:${FAKE}==`,
];

/** Where the pointer stands in a flag's value `v`: after it, before it, between its parts, or in a harmless key's. */
const FLAG_POINTERS: readonly ((value: string) => { text: string; kept: string[] })[] = [
  value => ({ text: `${value} ${POINTER}`, kept: [] }),
  value => ({ text: `${value}  ${POINTER}`, kept: [] }),
  value => ({ text: `${value}#${POINTER}`, kept: [] }),
  value => ({ text: `short ${value} ${POINTER}`, kept: [] }),
  value => ({ text: `${value} ${POINTER} short`, kept: [] }),
  value => ({ text: `${value} LOG_LEVEL=${POINTER}`, kept: [` LOG_LEVEL=${POINTER}`] }),
  value => ({ text: `${value} X-Trace: ${POINTER}`, kept: [` X-Trace: ${POINTER}`] }),
  // A value with a `:` or a key-shaped `=` after the pointer reads as the pointer's harmless key (declared G5b).
  value =>
    /[:=]/u.test(value.replace(/=+$/u, ''))
      ? { text: `${value} ${POINTER}`, kept: [] }
      : { text: `${POINTER} ${value}`, kept: [] },
  value =>
    /[:=]/u.test(value.replace(/=+$/u, ''))
      ? { text: `${value}#${POINTER}`, kept: [] }
      : { text: `${POINTER}#${value}`, kept: [] },
];

/** What a flag's value is when it IS no secret: composed with its pointer, too short, or only a pointer. */
const FLAG_CONTROLS: readonly string[] = [
  `Bearer ${POINTER}`,
  `${POINTER} short`,
  `short ${POINTER}`,
  POINTER,
  `$LONG_POINTER_NAME ${POINTER}`,
];

/** The flag family (review r4 B1): flag × form × value × pointer position, and the controls. */
function flagPointerCases(): NestedCase[] {
  const cases: NestedCase[] = [];
  const forms: readonly {
    readonly words: (flag: string, text: string) => string[];
    readonly at: number;
    readonly kept: (flag: string) => string[];
  }[] = [
    { words: (flag, text) => [flag, text], at: 2, kept: () => [] },
    { words: (flag, text) => [`${flag} ${text}`], at: 1, kept: flag => [`${flag} `] },
    { words: (flag, text) => [`${flag}=${text}`], at: 1, kept: flag => [`${flag}=`] },
  ];
  const add = (
    flag: string,
    form: (typeof forms)[number],
    text: string,
    secret: boolean,
    kept: readonly string[],
    body = FAKE,
  ) => {
    for (const last of [true, false]) {
      const words = [BEFORE, ...form.words(flag, text), ...(last ? [] : [AFTER])];
      cases.push({
        label: JSON.stringify(words),
        words,
        at: form.at,
        secret,
        body,
        kept: [...form.kept(flag), ...kept],
      });
    }
  };
  for (const form of forms) {
    for (const flag of SECRET_FLAGS) {
      for (const value of FLAG_VALUES) {
        for (const arrange of FLAG_POINTERS) {
          const { text, kept } = arrange(value);
          add(flag, form, text, true, kept);
        }
      }
      for (const control of FLAG_CONTROLS) add(flag, form, control, false, []);
      // CFG-LEAK-R (ii): text glued to a flag's pointer was a control; it is cut now, whole.
      for (const glued of [`prefix${POINTER}`, `${POINTER}?model=short`, `${POINTER}${POINTER}`])
        add(flag, form, glued, true, [], glued);
    }
    for (const flag of PLAIN_FLAGS) {
      // The same shapes with a value that holds no secret-named key (`<FAKE>:` names a secret), so a harmless flag
      // has nothing to cut.
      for (const value of FLAG_VALUES)
        for (const arrange of FLAG_POINTERS) add(flag, form, arrange(value.replaceAll(FAKE, HARMLESS)).text, false, []);
    }
  }
  return cases;
}

/**
 * A secret with base64 padding, or a base64 body of its own with separators in it: what stands after a pointer. Each
 * ends in a name that is no secret's (`Zm9v=`): `<FAKE>=` is itself a secret-named key and takes what follows it.
 */
const AFTER_VALUES = [
  `${FAKE}/Zm9v=`,
  `${FAKE}/Zm9v==`,
  `Basic ${FAKE}/Zm9v=`,
  `Basic ${FAKE}/Zm9v==`,
  `dXNlcjpw/${FAKE}+YmFy==`,
];

/** What stands around a padded value after a pointer: set apart by a space, two or `#`, with a part before, a pointer after. */
const AFTER_ARRANGEMENTS: readonly ((value: string) => { text: string; kept: string[] })[] = [
  value => ({ text: `${POINTER} ${value}`, kept: [] }),
  value => ({ text: `${POINTER}  ${value}`, kept: [] }),
  value => ({ text: `${POINTER}#${value}`, kept: [] }),
  value => ({ text: `${POINTER} short ${value}`, kept: [] }),
  value => ({ text: `${POINTER} ${value} ${POINTER}`, kept: [] }),
  value => ({ text: `${POINTER} ${value} MODEL=gpt-4o-mini`, kept: [' MODEL=gpt-4o-mini'] }),
  value => ({ text: `${POINTER} ${value}#LOG_LEVEL=${POINTER}`, kept: [`LOG_LEVEL=${POINTER}`] }),
];

/** After a pointer, a part that is no padding: a harmless key and its value, an empty key, or one too short. */
const AFTER_CONTROLS: readonly ((key: string) => string)[] = [
  key => `${key}${POINTER} MODEL=gpt-4o-mini`,
  key => `${key}${POINTER} FOO= bar`,
  key => `${key}${POINTER} FOO==`,
  key => `${key}${POINTER} short==`,
  key => `${key}${POINTER} x= y`,
  () => `LOG_LEVEL=${POINTER} ${FAKE}==`,
];

/** The padding-after-a-pointer family (review r4 B2): key × separator × position × padded value × arrangement. */
function afterPointerCases(): NestedCase[] {
  const cases: NestedCase[] = [];
  const add = (text: string, position: Position, secret: boolean, kept: readonly string[], last: boolean) => {
    const shape = placed(text, position);
    const words = [BEFORE, ...shape.words, ...(last ? [] : [AFTER])];
    cases.push({
      label: JSON.stringify(words),
      words,
      at: shape.at,
      secret,
      body: FAKE,
      kept: [...shape.kept, ...kept],
    });
  };
  for (const key of POINTER_KEYS) {
    for (const separator of ['=', ': ']) {
      for (const position of POINTER_POSITIONS) {
        for (const last of [true, false]) {
          for (const value of AFTER_VALUES) {
            for (const arrange of AFTER_ARRANGEMENTS) {
              const { text, kept } = arrange(value);
              add(`${key}${separator}${text}`, position, true, [`${key}${separator.trimEnd()}`, ...kept], last);
            }
          }
          for (const control of AFTER_CONTROLS) add(control(`${key}${separator}`), position, false, [], last);
        }
      }
    }
  }
  return cases;
}

/** Every generated case of ruling #40. */
export const nestedFamily = (): readonly NestedCase[] => [
  ...nestedKeyCases(),
  ...urlCases(),
  ...stuckTokenCases(),
  ...pointerCases(),
  ...secondCutCases(),
  ...paddedCases(),
  ...flagPointerCases(),
  ...afterPointerCases(),
];

/** What is wrong with what was shown, word by word, for one case; or nothing. */
export function nestedBreach(
  family: NestedCase,
  shown: readonly { readonly value: string; readonly hidden?: boolean }[],
): string | undefined {
  if (shown.length !== family.words.length) return `${family.label}: ${String(shown.length)} words shown`;
  // THE NET, a component's detail: a list the write rule still refused is withheld WHOLE (each word stands as withheld).
  if (family.secret && shown.every(word => word.hidden === true && word.value === WITHHELD)) return undefined;
  for (const [index, word] of family.words.entries()) {
    if (index === family.at && family.secret) continue;
    if (shown[index]?.value !== word || shown[index]?.hidden === true) return `${family.label}: changed ${word}`;
  }
  if (!family.secret) return undefined;
  const value = shown[family.at]?.value ?? '';
  if (shown.some(word => word.value.includes(family.body))) return `${family.label}: shows ${family.body}`;
  // THE NET: the write rule still refused the word, so a view says so in words and shows none of it: that hides it all.
  if (shown[family.at]?.hidden === true && value === WITHHELD) return undefined;
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
  // THE NET: the write rule still refused the line, so the view says so in words and shows none of it.
  if (line === WITHHELD) return undefined;
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
  if (five === WITHHELD) return true;
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
  if (five.hidden === true && five.value === WITHHELD) return true;
  if (today.hidden === true) return five.hidden === true && five.value === HIDDEN;
  if (five.hidden !== true) return five.value === word;
  return five.value.includes(HIDDEN) && lineHidesAtLeast(word, five.value);
}

/**
 * Whether `five` shows nothing of a word that ruling #37 hides (`command-line-37.ts`, the second floor): a word #37
 * hid stays hidden, and every piece 5.0 shows stands, in order, in what #37 showed — so #40 may cut more, inside the
 * word or at its end, but never shows a byte #37 cut (review r1 F2: `-H<token> KEY=v` must stay `-H‹hidden›`).
 */
export function hidesAtLeast37(word37: Shown, five: Shown): boolean {
  if (five.hidden === true && five.value === WITHHELD) return true;
  if (word37.hidden === true && five.hidden !== true) return false;
  if (five.hidden !== true) return five.value === word37.value;
  return five.value.includes(HIDDEN) && lineHidesAtLeast(word37.value, five.value);
}
