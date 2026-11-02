/**
 * The narrow test that refuses a copy (docs/catalogs.md § Copying a skill from this machine). A skill file may
 * quote a password the person typed once: copied into another account or project it would become a credential
 * somewhere it was never meant to be, and the review must never draw it. Two shapes are certain enough to
 * refuse on — an address with a password in it (`scheme://user:pass@host`) and an environment-style assignment
 * whose name announces a secret and whose value is long (`API_KEY=…`). Anything vaguer only WARNS
 * (`mayHoldSecret`). Pure and linear: plain scans, no backtracking pattern.
 */

const SECRET_NAME = /pass|pwd|secret|token|key|auth|cred|bearer|jwt|cookie|private/iu;
const ASSIGNED_NAME = /^-{0,2}[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u;
const MIN_VALUE_LENGTH = 16;
const ADDRESS_STOPS = new Set(['/', '?', '#', '"', "'", '<', '>', '`']);

/** A value that points at a secret rather than holding one: `$VAR`, `${VAR}`, `<your key>`, `%VAR%`, `[…]`. */
const isReference = (value: string): boolean => /^[$<{[%]/u.test(value);

const isSpace = (character: string): boolean => character.trim() === '';

function addressHoldsPassword(text: string): boolean {
  let from = text.indexOf('://');
  while (from !== -1) {
    const start = from + 3;
    for (let index = start; index < text.length; index += 1) {
      const character = text.charAt(index);
      if (isSpace(character) || ADDRESS_STOPS.has(character)) break;
      if (character !== '@') continue;
      const userInfo = text.slice(start, index);
      const colon = userInfo.indexOf(':');
      const password = colon === -1 ? '' : userInfo.slice(colon + 1);
      if (password !== '' && !isReference(password)) return true;
      break;
    }
    from = text.indexOf('://', start);
  }
  return false;
}

function assignmentHoldsSecret(token: string): boolean {
  const equals = token.indexOf('=');
  if (equals < 1) return false;
  const name = token.slice(0, equals);
  if (!ASSIGNED_NAME.test(name) || !SECRET_NAME.test(name)) return false;
  const value = token
    .slice(equals + 1)
    .replace(/^["'`]+/u, '')
    .replace(/["'`,;]+$/u, '');
  return value.length >= MIN_VALUE_LENGTH && !isReference(value);
}

/** Whether `text` holds a password in an address or a long value assigned to a secret-looking name. */
export function holdsCredential(text: string): boolean {
  if (addressHoldsPassword(text)) return true;
  return text.split(/\s+/u).some(assignmentHoldsSecret);
}
