/**
 * "ALWAYS USE FOR <PROJECT>", AS A DECISION (docs/input-requests.md, "Always use").
 *
 * After the owner taps a saved account on an input card, the card offers one quiet line: make that account the default
 * for this place in the asking session's project. Whether the line is offered is decided here, as a pure function, from
 * what the Vault's card handed the slot (ids and keys it already held) and the daemon's own account list; the component
 * only draws it and writes it on the owner's tap.
 *
 * Nothing here chooses an account for anyone: the line is drawn only for the very account the owner tapped, only on a
 * card whose project the DAEMON resolved (never a ferret's word), and only for a sign-in the daemon itself matches to the
 * card's place. The write goes through the owner route and is the owner's own act.
 */

import type { InputSettledSlotProps } from '@ferretry/core-vault/contract';
import {
  type AccountList,
  LoginMatchSchema,
  matchedSignIns,
  type PutAccountDefaultRequest,
} from '../../contract/routes/index.ts';
import { grantRefusalNotice } from '../shell.tsx';

/** What a tap on "Always use for <project>" would write, and the words that say so. */
export interface AlwaysUse {
  /** The project's name, as the daemon resolved it. */
  readonly project: string;
  /** The tapped account's label, from the daemon's own list. */
  readonly label: string;
  /** The place the default is for. */
  readonly key: string;
  readonly body: PutAccountDefaultRequest;
}

/**
 * The line "Always use for <project>", or `undefined` when it is not offered: no project was resolved, the card matched no
 * place, the tap named no sign-in, the account was already the project's default, the sign-in is not one of the tapped
 * account's, or the daemon does not match it to this place.
 */
export const alwaysUseFor = (slot: InputSettledSlotProps, list: AccountList): AlwaysUse | undefined => {
  const { project, place, signIn: signInId, entry } = slot;
  if (project === undefined || place === undefined || signInId === undefined) return undefined;
  if (slot.projectDefault === true) return undefined;
  const key = LoginMatchSchema.safeParse(place);
  if (!key.success) return undefined;
  const signIn = list.signIns.find(each => each.id === signInId);
  if (signIn === undefined || signIn.account !== entry) return undefined;
  if (matchedSignIns(key.data, [signIn]).length === 0) return undefined;
  const account = list.accounts.find(each => each.id === signIn.account);
  if (account === undefined) return undefined;
  return {
    project: project.name,
    label: account.label,
    key: key.data,
    body: { scope: 'projects', within: project.id, key: key.data, account: account.id },
  };
};

/** A sentence with the project's name in it: what comes before, the name, and what comes after (the sentence is the three joined). */
export interface AlwaysUseWords {
  readonly before: string;
  readonly project: string;
  readonly after: string;
}

/** The sentence after the write. */
export const alwaysUseSavedParts = (always: AlwaysUse): AlwaysUseWords => ({
  before: `${always.label} is now the default for `,
  project: always.project,
  after: ` at ${always.key}.`,
});

/** What the button says it would do, under it. */
export const alwaysUseExplainParts = (always: AlwaysUse): AlwaysUseWords => ({
  before: `Makes ${always.label} the default for ${always.key} in `,
  project: always.project,
  after: '.',
});

/** A refused or failed write, in fixed words: a grant refusal says so, anything else says nothing changed. Never an echo. */
export const alwaysUseFailureWords = (error: unknown): string =>
  grantRefusalNotice(error)?.guidance.explanation ?? 'Could not save that default. Nothing changed.';
