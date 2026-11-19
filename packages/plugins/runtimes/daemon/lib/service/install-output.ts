/**
 * What a package manager's output may say once it is handed to a person.
 *
 * A manager prints progress, warnings and, now and then, a registry token (an `.npmrc` line in an error, an
 * `Authorization` header in a verbose trace). The install answer carries the last few lines so a person can see what
 * happened, so every line goes through here first: colour and control characters out, token-shaped words hidden, any line
 * that names a credential dropped whole, and the whole thing bounded. Pure.
 */
import { HIDDEN_VALUE_TEXT, looksSecret, SECRET_TOKEN_SOURCE, urlPasswordCuts } from '@ferretry/std/credential-words';
import { stripTerminalEscapes } from './foreign.ts';

/** How many trailing lines an answer carries. */
const INSTALL_OUTPUT_LINES = 20;

/** One shown line is cut here. */
const MAX_LINE_CHARACTERS = 200;

const TOKEN_WORDS = new RegExp(SECRET_TOKEN_SOURCE, 'gu');

/** A line that names a credential, whatever its value looks like. */
const CREDENTIAL_LINE = /(?:_authToken|_auth\b|_password|authorization\s*:|bearer\s+\S|password\s*[=:])/iu;

/** `NAME=value` words, so a secret-named variable's value is hidden even when it has no known prefix. */
const ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*)=(\S+)/gu;

/** The line with every URL user's password (`scheme://user:PASS@host`) hidden, whatever the password looks like. */
function withoutUrlPasswords(line: string): string {
  return [...urlPasswordCuts(line)]
    .sort((a, b) => b[0] - a[0])
    .reduce((text, [from, to]) => `${text.slice(0, from)}${HIDDEN_VALUE_TEXT}${text.slice(to)}`, line);
}

function scrubLine(raw: string): string | undefined {
  const line = stripTerminalEscapes(raw).trim();
  if (line === '') return undefined;
  if (CREDENTIAL_LINE.test(line)) return `${HIDDEN_VALUE_TEXT} (a line that names a credential was left out)`;
  const hidden = withoutUrlPasswords(line)
    .replaceAll(TOKEN_WORDS, HIDDEN_VALUE_TEXT)
    .replaceAll(ASSIGNMENT, (whole, name: string, value: string) =>
      looksSecret(name, value) ? `${name}=${HIDDEN_VALUE_TEXT}` : whole,
    );
  return hidden.slice(0, MAX_LINE_CHARACTERS);
}

/** The last {@link INSTALL_OUTPUT_LINES} non-empty lines of a manager's output, scrubbed. */
export function scrubInstallOutput(tail: readonly string[]): readonly string[] {
  return tail
    .map(scrubLine)
    .filter((line): line is string => line !== undefined)
    .slice(-INSTALL_OUTPUT_LINES);
}
