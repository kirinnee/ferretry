/** Sign-ins, 2FA keys, phone approval, task plans and the standing sign-in and paste rules (`accounts.*`, `input.*`, `task-plan.*`, `sign-in-rules*`, `copy-rules.*`). One fragment of `DAEMON_FEATURES`; `index.ts` spreads them all. */
export const SECRETS_FEATURES = {
  /**
   * Accounts and sign-ins (docs/input-requests.md, "Accounts and sign-ins"): `/v1/accounts*`, a card offer's
   * `signIn`/`primary`/`why`, a deliver's `signIn` and a `si_` `secretHint` that orders the card. The app reads an
   * offer's `primary`/`why` and sends a deliver's `signIn` whenever the offer carries one, with or without this name
   * (only a daemon that understands sign-ins sends either); a daemon that takes a deliver's `signIn` refuses one that is
   * not of the deliver's account, with nothing typed.
   * REPORTED SINCE THE APP DRAWS THE SCREEN (Settings › Accounts): a daemon without this name keeps today's saved-logins
   * surface, and that is all the name chooses.
   */
  accountsSignIns: 'accounts.signins.1',
  /**
   * 2FA keys (docs/input-requests.md, "Accounts and sign-ins"): an account's `factors` routes, saving a seed with an
   * `add-2fa-key` passkey bound to its stage, a code card titled from its keys and "Use code from Ferretry" per key
   * (a deliver's `factor`). A daemon without this name may lack these routes or refuse a deliver naming a key, so the
   * app offers neither and keeps today's one-seed surface.
   * REPORTED SINCE THE APP DRAWS THE KEYS (the code card, the "Set up automatic codes" panel and Settings › Accounts ›
   * 2FA keys).
   */
  twoFactorKeys: 'accounts.2fa-keys.1',
  /**
   * Approve on your phone (docs/input-requests.md, "Approve on your phone"): `push: true` on a request tool, an
   * `info` card with a `phoneApproval` ref, and `input_wait` on its `pa_` id. A daemon without this name refuses
   * `push: true`, and an app without the card shows the item as a plain info card with the daemon's subject.
   * REPORTED SINCE THE APP DRAWS THE CARD (the agenda's approve-on-phone card, the push, and "Not me — stop"): the daemon
   * offers `push: true` only while this name is in {@link daemonFeatureList}.
   */
  phoneApproval: 'input.phone-approval.1',
  /**
   * Task plans (docs/secure-copy.md, "Task plans"): `task.plan`, a plan card with sign-in, terminal sign-in and paste
   * lines, approving a sign-in line with an `approve-task-plan` passkey bound to its staged selection, and Ferretry
   * filling a covered sign-in itself. The input request and its outcome carry a `plan` actor and a `preapproval` note,
   * which an older app's strict parse refuses, so the daemon fills under a plan only while it reports this name.
   * REPORTED SINCE THE APP SHOWS THE PLAN CARD: an app that cannot show it keeps the copy-plan card.
   */
  taskPlan: 'task-plan.1',
  /**
   * Standing sign-in rules (sign-in-rules.ts, docs/input-requests.md): the owner's passkey-signed permission, kept on
   * disk, for Ferretry to fill one sign-in (a page, or sudo, su or doas in a terminal beside {@link
   * DAEMON_FEATURES.signInRulesTerminal}) for any ferret until it expires. The input request and its outcome carry a
   * `sign-in-rule` actor and a `preapproval` note by rule, which an older app's strict parse refuses, so the daemon
   * fills under a rule only while it reports this name.
   * REPORTED SINCE R3c-6, WHEN THE APP DRAWS THE RULE SHEET AND CARDS.
   */
  signInRules: 'sign-in-rules.1',
  /**
   * Standing rules for TERMINAL sign-ins (sudo, su or doas: root on demand, sign-in-rules.ts): staged, offered to the
   * matcher and filled only while the daemon reports this name, beside `sign-in-rules.1`. A daemon that does not report
   * it refuses to stage one (`tool_not_covered`) and offers no terminal rule to a fill, whatever its file holds.
   * REPORTED, with its known limit, by owner decision !A226 (docs/secrets.md › Terminal rules, "Accepted risk"). A
   * terminal rule still fills only beside `sign-in-rules.1`: while that is not reported, every raise is a plain card.
   */
  signInRulesTerminal: 'sign-in-rules-terminal.1',
  /**
   * A paste rule is made only with a passkey bound to it (docs/secure-copy.md, owner decision !A244): staged at
   * `POST /v1/copy-rules/stages` with the daemon's rows, committed with a fresh `approve-paste-rule` proof for that stage,
   * and the old one-step `POST /v1/copy-rules` makes nothing. The app and `fy copy rules add` stage where the machine
   * reports this name, and keep the one-step create on a daemon that does not.
   */
  pasteRulePasskey: 'copy-rules.passkey.1',
} as const;
