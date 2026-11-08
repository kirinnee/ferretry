/**
 * Private keys as a component's text holds them (#36, r5), for the S26 redaction tests: every header, line break —
 * real, or written as an escape as a service account's JSON does (`"private_key": "-----BEGIN…\n…"`) — body (a line
 * that starts the way a token does among them, `eyJ…`, `AIza…`, which an earlier pass hides on its own) and place a
 * key stands in, under a name that announces a secret and under one that does not.
 *
 * Every key here is an obviously fake one: no body line is base64 of anything.
 */

/** What every body line holds, so a test can tell that none of it shows. */
export const KEY_BODY_MARK = 'KeyBodyLine';
/** What follows each key on a line of its own, and must show as written. */
export const AFTER_KEY = 'after: fake-shown-0000';
/** What follows the key inside the JSON place, and must show as written. */
const BESIDE_KEY = '"client_email": "fake@example.invalid"';

const LINES = {
  plain: `MIIEfake${KEY_BODY_MARK}0001`,
  jwt: `eyJfake${KEY_BODY_MARK}0002`,
  google: `AIzaFake${KEY_BODY_MARK}0003`,
  padded: `Zm9vfake${KEY_BODY_MARK}0004==`,
};
const BODIES: Readonly<Record<string, readonly string[]>> = {
  plain: [LINES.plain, LINES.padded],
  'eyJ first': [LINES.jwt, LINES.plain, LINES.padded],
  'eyJ inside': [LINES.plain, LINES.jwt, LINES.padded],
  'AIza inside': [LINES.plain, LINES.google, LINES.padded],
  'AIza last': [LINES.plain, LINES.padded, LINES.google],
};
/** Each break between the key's lines, and the line ending of the text around the key. */
const BREAKS: readonly (readonly [string, string])[] = [
  ['\n', '\n'],
  ['\r\n', '\r\n'],
  ['\\n', '\n'],
  ['\\r\\n', '\n'],
];
const HEADERS = ['RSA PRIVATE KEY', 'PRIVATE KEY', 'OPENSSH PRIVATE KEY'];
const PLACES: Readonly<Record<string, (key: string, ending: string) => string>> = {
  bare: key => key,
  'password: key': key => `password: ${key}`,
  'private_key: key': key => `private_key: ${key}`,
  'TOKEN=key': key => `TOKEN=${key}`,
  JSON: key => `{"type": "service_account", "private_key": "${key}\\n", ${BESIDE_KEY}}`,
  'a name that announces no secret': key => `key: ${key}`,
  'the line after its name': (key, ending) => `password:${ending}${key}`,
  'a block under its name': (key, ending) => `password: |${ending}  ${key}`,
};

export interface PrivateKeyShape {
  readonly shape: string;
  readonly text: string;
  /** What must show as written. */
  readonly shown: readonly string[];
}

/** Every key shape, each followed by {@link AFTER_KEY} on a line of its own. */
export function privateKeyShapes(): readonly PrivateKeyShape[] {
  return Object.entries(PLACES).flatMap(([place, write]) =>
    Object.entries(BODIES).flatMap(([body, lines]) =>
      BREAKS.flatMap(([gap, ending]) =>
        HEADERS.map(header => {
          const key = [`-----BEGIN ${header}-----`, ...lines, `-----END ${header}-----`].join(gap);
          return {
            shape: `${place}, ${body}, ${JSON.stringify(gap)}, ${header}`,
            text: `${write(key, ending)}${ending}${AFTER_KEY}`,
            shown: place === 'JSON' ? [BESIDE_KEY, AFTER_KEY] : [AFTER_KEY],
          };
        }),
      ),
    ),
  );
}
