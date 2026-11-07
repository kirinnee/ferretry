/**
 * Config-file raw-secret refusal copied from today's fleet/lib/config-files/secrets.ts.
 * MCP uses the nested-env rule: no top-level origin-id exemption applies here. Pure, with no IO.
 */
export const RAW_SECRET_MESSAGE = 'this looks like a raw secret (an API key or token)';
export const RAW_SECRET_FIX = `store the value with \`fy secret set NAME\`, then write \${secret:NAME} here instead — a secret value never goes in a configuration file`;

const KNOWN_SHAPES: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/u,
  /\bsk-or-[A-Za-z0-9_-]{8,}/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
  /\bgsk_[A-Za-z0-9]{20,}/u,
  /\bcsk-[A-Za-z0-9]{20,}/u,
  /\bAIza[0-9A-Za-z_-]{30,}/u,
  /\bglpat-[A-Za-z0-9_-]{16,}/u,
];
const CREDENTIAL_KEY = /(?:(?:key|token|secret|password|passwd)s?|credentials?)$/iu;
const REFERENCE = /^\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)$/u;
const MIN_SECRET_LENGTH = 16;
const ENTROPY_THRESHOLD = 3.5;

function shannonEntropy(value: string): number {
  const characters = [...value];
  const counts = new Map<string, number>();
  for (const character of characters) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / characters.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Whether an environment value looks like a provider key, or random text under a credential name. */
export function looksLikeRawSecret(key: string, value: string): boolean {
  if (KNOWN_SHAPES.some(shape => shape.test(value))) return true;
  if (!CREDENTIAL_KEY.test(key)) return false;
  const trimmed = value.trim();
  if (REFERENCE.test(trimmed) || trimmed.length < MIN_SECRET_LENGTH || /\s/u.test(trimmed)) return false;
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|[/~.])/iu.test(trimmed)) return false;
  return shannonEntropy(trimmed) >= ENTROPY_THRESHOLD;
}
