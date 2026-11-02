import { SIGN_IN_RULE_HONEST_LIMIT } from '@ferretry/protocol';

export { SIGN_IN_RULE_HONEST_LIMIT };

/**
 * THE DAEMON'S WORDS FOR A STANDING RULE'S AUDIT. What the passkey dialog shows is the protocol's `signInRuleWords`
 * (one builder, so every app shows what the daemon states); this is only the audit's one-line text.
 */

/** An audit text value: one line, 1–160 characters. */
export const auditText = (text: string): string => {
  const flat = text.replaceAll(/[\p{Cc}\p{Cf}]+/gu, ' ').trim();
  return flat === '' ? 'none' : flat.length <= 160 ? flat : `${flat.slice(0, 159)}…`;
};
