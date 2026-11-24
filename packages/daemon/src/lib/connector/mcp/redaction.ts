/**
 * What a connector tool may let out: every text that came from a ferret or the daemon passes through here.
 *
 * TWO LAYERS, because each catches what the other cannot. The daemon's `TextRedactor` knows the VALUES of the
 * secrets stored on this machine and masks them wherever they appear; it cannot know a credential the owner
 * never stored (a token a ferret printed from its own login, a key in a pasted log). The pattern layer here
 * knows the SHAPES of common credentials and masks those; it cannot know a secret with no recognisable shape.
 * Neither is complete — docs/secrets.md says what the first does and does not catch — which is why the
 * connector also has no tool that reads a file, an environment or a command's output.
 *
 * FAIL CLOSED. If either layer throws — the vault cannot be opened, a regular expression meets something it
 * cannot take — the answer is {@link WITHHELD}, never the raw text and never a blank.
 */

import type { TextRedactor } from '../../secrets/redaction.ts';

/** What a masked span becomes. */
export const REDACTED = '[redacted]';

/** What a text becomes when redaction could not run. */
export const WITHHELD = '[output withheld]';

interface Rule {
  readonly pattern: RegExp;
  readonly replace: string | ((substring: string, ...groups: string[]) => string);
}

/** A key that names a credential, as it is written in config, env files, headers and JSON. */
const SECRET_KEY =
  '(?:[A-Za-z0-9]+[_-])*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential|auth(?:orization)?)s?';

/**
 * Ordered: the structural rules first (a PEM block or a URL's userinfo would otherwise be half-eaten by a
 * later rule), then the token shapes, then `key=value` assignments, which keep the key and mask the value only.
 */
const RULES: readonly Rule[] = [
  // PEM private keys. An unterminated block (a truncated tail) is masked to the end: fail closed.
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/gu,
    replace: '[redacted private key]',
  },
  // scheme://user:pass@host — the userinfo is the credential.
  { pattern: /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gu, replace: `$1${REDACTED}@` },
  // Ferretry's own: session credentials (fys_), connector tokens (fyc_at_, fyc_rt_), anything fy?_ shaped.
  { pattern: /\bfy[a-z]_[A-Za-z0-9_-]{6,}/gu, replace: REDACTED },
  // Anthropic, then OpenAI (`sk-` incl. `sk-proj-`), which would also match Anthropic's if run first.
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{6,}/gu, replace: REDACTED },
  { pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/gu, replace: REDACTED },
  // GitHub.
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/gu, replace: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{16,}/gu, replace: REDACTED },
  // AWS access key ids.
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, replace: REDACTED },
  // Slack.
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{8,}/gu, replace: REDACTED },
  // Google API keys.
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}/gu, replace: REDACTED },
  // JSON web tokens (header.payload.signature, header starts `eyJ`).
  { pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/gu, replace: REDACTED },
  // `Bearer <token>`.
  { pattern: /\b(Basic)[ \t]+[A-Za-z0-9+/=]{8,}/gu, replace: `$1 ${REDACTED}` },
  { pattern: /\b(Bearer)[ \t]+[A-Za-z0-9._~+/=-]{8,}/giu, replace: `$1 ${REDACTED}` },
  // `password=…`, `"api_key": "…"`, `TOKEN: …` — the value only. Quoted values may hold spaces.
  {
    pattern: new RegExp(
      `(\\b${SECRET_KEY}["']?\\s*[:=]\\s*)(?!\\[redacted\\]|Bearer\\b|Basic\\b)(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s"',;&)}\\]]+)`,
      'giu',
    ),
    replace: (_whole, head) => `${head}${REDACTED}`,
  },
];

/** Masks the SHAPES of common credentials. Pure and synchronous; may throw only on a pathological input. */
export function redactCredentialPatterns(text: string): string {
  let result = text;
  for (const rule of RULES) {
    result =
      typeof rule.replace === 'string'
        ? result.replace(rule.pattern, rule.replace)
        : result.replace(rule.pattern, rule.replace);
  }
  return result;
}

/**
 * The one door every connector text leaves through. Constructed with the daemon's stored-secret redactor.
 */
export class ConnectorTextGuard {
  constructor(private readonly secrets: Pick<TextRedactor, 'redact'>) {}

  /** The text with stored secret values and credential shapes masked, or {@link WITHHELD}. Never throws. */
  async clean(text: string): Promise<string> {
    try {
      return redactCredentialPatterns(await this.secrets.redact(redactCredentialPatterns(text)));
    } catch {
      return WITHHELD;
    }
  }

  /** Several texts, each cleaned independently (one that cannot be cleaned does not blank the others). */
  async cleanAll(texts: readonly string[]): Promise<string[]> {
    return await Promise.all(texts.map(async text => await this.clean(text)));
  }

  /** Clean every string inside a JSON-like value (for the calls log). Withheld where a string cannot be cleaned. */
  async cleanData(value: unknown): Promise<unknown> {
    if (typeof value === 'string') return await this.clean(value);
    if (Array.isArray(value)) return await Promise.all(value.map(async entry => await this.cleanData(entry)));
    if (typeof value === 'object' && value !== null) {
      const entries = await Promise.all(
        Object.entries(value).map(async ([key, entry]) => [key, await this.cleanData(entry)] as const),
      );
      return Object.fromEntries(entries);
    }
    return value;
  }
}
