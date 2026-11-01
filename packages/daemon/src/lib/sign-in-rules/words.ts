import {
  type AccountRef,
  type Place,
  placeWords,
  SIGN_IN_RULE_HONEST_LIMIT,
  type SignInField,
  type SignInRuleScope,
  TASK_PLAN_SUMMARY_LINE_MAX_CHARS,
} from '@ferretry/protocol';

export { SIGN_IN_RULE_HONEST_LIMIT };

/**
 * THE DAEMON'S WORDS FOR A STANDING RULE: the passkey dialog's summary and the audit's text. Every word comes from what
 * the daemon resolved (the account, the place, the fields it would type); none is a value. The summary names the
 * FIELDS FIRST, so a clipped line never hides "and the 2FA code", and the dialog draws its warnings and the sign-in
 * itself from the staged rule's structured fields, never from these words (secrev-1268 N1, secrev-1271 L3).
 */

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const line = (text: string): string =>
  clip(
    text
      .replaceAll(/[\p{Cc}\p{Cf}]+/gu, ' ')
      .replaceAll(/\s+/gu, ' ')
      .trim(),
    TASK_PLAN_SUMMARY_LINE_MAX_CHARS,
  );

/** "username, password and 2FA code". */
export const ruleFieldWords = (fields: readonly SignInField[]): string => {
  const named = fields.map(field => (field === 'totp' ? '2FA code' : field));
  return named.length <= 1 ? (named[0] ?? '') : `${named.slice(0, -1).join(', ')} and ${named.at(-1) ?? ''}`;
};

/** Which ferrets a rule fills for, in words. */
export const scopeWords = (scope: SignInRuleScope): string =>
  scope.kind === 'any'
    ? 'for any ferret on this machine'
    : scope.kind === 'project'
      ? `only for ferrets in board project ${scope.project}`
      : `only for session ${scope.session}`;

/** The day a rule ends, in the machine's words (UTC). */
const dayOf = (instant: string): string => new Date(instant).toISOString().slice(0, 10);

/** What the passkey approves, line by line, fields first. */
export function stagedSummary(facts: {
  readonly fields: readonly SignInField[];
  readonly account: AccountRef;
  readonly username?: string | undefined;
  readonly place: Place;
  readonly scope: SignInRuleScope;
  readonly expiresAt: string;
  readonly uses?: number | undefined;
  readonly autoRecipe: boolean;
  readonly revision: number;
}): readonly string[] {
  return [
    line(`Ferretry types the ${ruleFieldWords(facts.fields)} without asking`),
    line(
      `${facts.account.label}${facts.username === undefined ? '' : ` · ${facts.username}`} ${placeWords(facts.place)}`,
    ),
    line(scopeWords(facts.scope)),
    line(
      `until ${dayOf(facts.expiresAt)}, ${facts.uses === undefined ? 'with no use limit' : `at most ${String(facts.uses)} times`}`,
    ),
    ...(facts.autoRecipe ? [line("Its recipe takes a ferret's edits without your review")] : []),
    ...(facts.revision > 1 ? [line(`Approves this rule again (revision ${String(facts.revision)})`)] : []),
  ];
}

/** An audit text value: one line, 1–160 characters. */
export const auditText = (text: string): string => {
  const flat = text.replaceAll(/[\p{Cc}\p{Cf}]+/gu, ' ').trim();
  return flat === '' ? 'none' : flat.length <= 160 ? flat : `${flat.slice(0, 159)}…`;
};
