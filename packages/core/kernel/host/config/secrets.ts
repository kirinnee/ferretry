/**
 * What the kernel SAYS about a raw secret in a configuration file (the detection itself is `@ferretry/std/credential-words`:
 * one implementation, shared with Runtimes). A configuration file may NEVER hold a secret value (docs/config-files.md): a
 * secret lives in the secret store (`<binary> secret set NAME`) and a file names it as `${secret:NAME}`.
 *
 * WHAT A MESSAGE NEVER DOES is repeat the value: it names where the value is and how to fix it, so a secret pasted by
 * mistake travels no further than the file it was pasted into.
 */

/** What a person is told to do instead, in one sentence. */
export const rawSecretFix = (binary: string): string =>
  `store the value with \`${binary} secret set NAME\`, then write \${secret:NAME} here instead — a secret value never goes in a configuration file`;

/** What the finding is, in one sentence that never includes the value. */
export const RAW_SECRET_MESSAGE = 'this looks like a raw secret (an API key or token)';

/** The same for a NAME: it never includes the name. */
export const RAW_SECRET_KEY_MESSAGE = 'a name in here looks like a raw secret (an API key or token)';

/** What a secret found only in the raw text is, in one sentence that never includes it: a comment or a tag counts. */
export const RAW_TEXT_SECRET_MESSAGE =
  'this line looks like it holds a raw secret (an API key or token) — a comment or a tag counts';
