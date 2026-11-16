/**
 * THE `${secret:NAME}` pointer grammar, declared once. A configuration file never holds a secret value: it holds a
 * pointer to one in the secret store, and every program that reads, writes, masks or resolves a file asks THIS grammar
 * what a pointer is (the kernel's contract, the Vault's contract, the word cutter and the write rule in
 * `./credential-words`). It is the one Ferretry-shaped fact in `@ferretry/std`, and it is here because two contracts
 * and two plugins must agree on it byte for byte (docs/standards/fact-ownership).
 *
 * A bare string and three tiny functions: no import, so an app half may import it without pulling anything else.
 */

/** The `${secret:NAME}` grammar: a name starts with a capital letter and runs to 64 characters of capitals, digits, `_`. */
export const SECRET_REFERENCE_SOURCE = '\\$\\{secret:([A-Z][A-Z0-9_]{0,63})\\}';

/**
 * What stands in a shown text for a value that is not shown, and so can never be typed as one. THE one spelling: the
 * kernel's read mask, Runtimes' views and Runtimes' wire all show and refuse it, so a person sees one spelling
 * everywhere.
 */
export const HIDDEN_VALUE_TEXT = '‹hidden›';

/** The shortest value the secret store accepts: a shorter one is a flag, not a credential (`AUTH=1`). */
export const MIN_SECRET_VALUE_LENGTH = 8;

/** The grammar as a fresh global pattern (a global pattern keeps its position between uses). */
export const secretReferencePattern = (): RegExp => new RegExp(SECRET_REFERENCE_SOURCE, 'gu');

/** Whether a text holds a well-formed `${secret:NAME}` reference. */
export const holdsSecretReference = (value: string): boolean => new RegExp(SECRET_REFERENCE_SOURCE, 'u').test(value);
