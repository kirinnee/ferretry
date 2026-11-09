import { looksSecret } from '../../../daemon/lib/account/import.ts';

/**
 * `redactText` exactly as it stood in 4.291.5 before the line-break and linearity work
 * (`packages/daemon/src/lib/fleet/catalog.ts`), frozen here.
 *
 * It is the "never hide less than this" floor: the differential test (`redact-differential.test.ts`, S26) generates
 * text and asserts that every secret value this function hid is also hid by the real `redactText`. It is quadratic on
 * a long run of name characters and its `\s*` crosses line breaks; both are why the real one differs, so keep it as it
 * was and only feed it short text. Do not "fix" it: change the real one instead.
 */
const ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"'`,;)}\]]+)/gu;
const WORD = /[^\s"'`,;()[\]{}<>]+/gu;
const HIDDEN_TEXT = '‹hidden›';

export function referenceRedactText(text: string): { readonly text: string; readonly redacted: boolean } {
  let redacted = false;
  const named = text.replace(ASSIGNMENT, (whole, name: string, separator: string, value: string) => {
    if (!looksSecret(name, value)) return whole;
    redacted = true;
    return `${name}${separator}${HIDDEN_TEXT}`;
  });
  const bare = named.replace(WORD, word => {
    if (!looksSecret('', word)) return word;
    redacted = true;
    return HIDDEN_TEXT;
  });
  return { text: bare, redacted };
}
