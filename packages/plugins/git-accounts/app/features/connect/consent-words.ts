/**
 * WHAT FERRETRY ASKS GITHUB FOR, in the owner's words (r9 choice 3), shown BEFORE the code card. One constant, so the
 * screen and its test cannot drift: the test reads every scope the daemon asks for (`GITHUB_SCOPES`) out of it.
 *
 * `repo` is said plainly: the token can read and write EVERY repository the account can reach. It is never shown or
 * returned; ferrets can only use it through the daemon. `**x**` marks a bold word and `x` in backticks a code word (the
 * card splits on them; there is no Markdown parser here).
 */
export interface ConsentItem {
  readonly title: string;
  /** The GitHub scope names this line covers, spelled as GitHub spells them. */
  readonly scopes: readonly string[];
  readonly text: string;
}

export const CONSENT_HEADING = 'What Ferretry asks GitHub for';

export const CONSENT_ITEMS: readonly ConsentItem[] = [
  {
    title: 'Your profile and email',
    scopes: ['read:user', 'user:email'],
    text: 'to sign your commits as you.',
  },
  {
    title: 'Add SSH and GPG keys',
    scopes: ['write:public_key', 'write:ssh_signing_key', 'write:gpg_key'],
    text: 'so ferrets can push and sign as you without a password.',
  },
  {
    title: 'Your repositories',
    scopes: ['repo'],
    text: 'read and write **every** repository you can reach, public and private: code, pull requests, issues and CI. Ferretry uses it to show PRs and CI here, to post the comments you write here, and for the `gh` your ferrets run in a linked project.',
  },
  {
    title: 'Your organisations',
    scopes: ['read:org'],
    text: 'to list your organisations’ repositories and teams.',
  },
];

export const CONSENT_MEANING_HEADING = 'What this means:';

export const CONSENT_MEANING =
  'a ferret working in a project linked to this account can act on GitHub as you: push, open and merge pull requests, and comment. It can **use** this access. It can never **read** the token.';

export const CONSENT_LIMIT =
  'GitHub cannot limit this to some repositories for this kind of app. Remove the account here at any time. To fully revoke it, open github.com/settings/applications.';

export const CONSENT_CONTINUE = 'Continue to GitHub';
