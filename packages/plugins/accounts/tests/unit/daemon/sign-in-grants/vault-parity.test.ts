/**
 * appd-acc F4 (row 83): ONE RULE, TWO COPIES, KEPT EQUAL. Accounts' `vault-inputs.ts` and `sign-in-grants/matcher.ts` (and
 * the contract helpers they call) are copies of the Vault's `saved-logins.ts`, `login-observer.ts`, `lock.ts`,
 * `borrowed-grants.ts` and `borrowed.ts`: Accounts' plan and rule paths decide with the first, the Vault's tap and fill path
 * with the second, so a copy that drifts is a fill one half allows and the other half refuses. The rule is security
 * (where a one-time code or a saved password may be typed), and nothing but a comment said "copied".
 *
 * A TEXT comparison, not a behavioural one: a package reaches another only through its contract (the `context-imports`
 * gate), so a test here cannot import the Vault's daemon code to run both. Each named declaration, and every helper a named declaration calls, is read out of its file
 * on both sides (a function or a constant, by name, from the syntax tree), comments and layout are removed, and what is
 * left must be the same text. Test-only: neither copy is edited here, and a rule that must change changes in both.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AstNode, parseFile, walk } from '../../../../../../../scripts/gen/lib/check.ts';

const PLUGIN = join(import.meta.dir, '..', '..', '..', '..');
const VAULT = join(PLUGIN, '..', '..', 'core', 'vault', 'daemon', 'lib', 'inputs');
const accountsFile = (relative: string): string => join(PLUGIN, relative);
const vaultFile = (name: string): string => join(VAULT, name);

const INPUTS = accountsFile('daemon/lib/vault-inputs.ts');
const MATCHER = accountsFile('daemon/lib/sign-in-grants/matcher.ts');
const BORROWED = vaultFile('borrowed.ts');
const GRANTS = vaultFile('borrowed-grants.ts');

/** The rule's declarations and the file each side keeps each in: the code-target rule, the form identity, the terminal rule, the grant matcher and the helpers it reads. */
const COPIED: readonly (readonly [name: string, accounts: string, vault: string])[] = [
  ['codeTargetProblem', INPUTS, vaultFile('saved-logins.ts')],
  ['identityOf', INPUTS, vaultFile('login-observer.ts')],
  ['SECOND_FACTOR_WINDOW_MS', INPUTS, vaultFile('login-observer.ts')],
  ['terminalHides', INPUTS, vaultFile('lock.ts')],
  ['GETPASS_PROGRAMS', INPUTS, vaultFile('lock.ts')],
  ['matchSignInGrant', MATCHER, GRANTS],
  ['pageProblem', MATCHER, GRANTS],
  ['terminalProblem', MATCHER, GRANTS],
  ['rolesUnder', MATCHER, GRANTS],
  ['scopeCovers', MATCHER, GRANTS],
  ['scriptedSince', MATCHER, GRANTS],
  ['sameKeys', MATCHER, GRANTS],
  ['fieldSetOf', MATCHER, GRANTS],
  ['miss', MATCHER, GRANTS],
  ['TASK_PLAN_TERMINAL_TOOLS', accountsFile('contract/routes/task-plan.ts'), BORROWED],
  ['GRANT_STOPPING_REASONS', accountsFile('contract/routes/task-plan.ts'), BORROWED],
  ['ruleMissSuspends', accountsFile('contract/routes/task-plan.ts'), BORROWED],
  ['signInRuleSuspensionOf', accountsFile('contract/routes/sign-in-rules.ts'), BORROWED],
  ['factorFingerprint', accountsFile('contract/routes/sign-in-rules.ts'), BORROWED],
  ['placeKeys', accountsFile('contract/routes/accounts.ts'), BORROWED],
  ['automaticKeysInOfferOrder', accountsFile('contract/routes/accounts.ts'), BORROWED],
  ['fillRoleFor', accountsFile('contract/routes/login-entries.ts'), BORROWED],
  ['terminalKey', accountsFile('contract/routes/accounts.ts'), BORROWED],
  ['VERIFIED_RANK', accountsFile('contract/routes/accounts.ts'), BORROWED],
  ['sha256Hex', accountsFile('contract/routes/sha256.ts'), BORROWED],
  ['K', accountsFile('contract/routes/sha256.ts'), BORROWED],
  ['SIGN_IN_RULE_FACTORS_DOMAIN', accountsFile('contract/routes/sign-in-rules.ts'), BORROWED],
  ['SIGN_IN_RULE_SUSPENSIONS', accountsFile('contract/routes/sign-in-rules.ts'), BORROWED],
  ['SignInRuleSuspensionSchema', accountsFile('contract/routes/sign-in-rules.ts'), BORROWED],
  ['digest', INPUTS, vaultFile('login-observer.ts')],
];

/** Comments out, layout and trailing commas gone: what is left is the code the compiler reads. */
const code = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:'"`])\/\/.*$/gmu, '$1')
    .replace(/\s+/gu, ' ')
    .replace(/\s*([{}()[\],;:=<>|&?+*/-])\s*/gu, '$1')
    .replace(/,([)\]}])/gu, '$1')
    .trim();

/** The text of every top-level function or constant declaration of one file named `name` (a local of a function is not the rule's). */
function declared(file: string, name: string): readonly string[] {
  const source = readFileSync(file, 'utf8');
  const found: string[] = [];
  walk(parseFile(file).program, (node, parents) => {
    if (parents.some(p => p.type !== 'Program' && p.type !== 'ExportNamedDeclaration')) return;
    if (node.type === 'FunctionDeclaration' && (node.id as AstNode | null)?.name === name)
      found.push(code(source.slice(node.start, node.end)));
    if (node.type === 'VariableDeclaration')
      for (const declarator of node.declarations as readonly AstNode[])
        if ((declarator.id as AstNode).name === name) found.push(code(source.slice(node.start, node.end)));
  });
  return found;
}

describe('appd-acc F4 the copied sign-in rules stay equal to the Vault’s', () => {
  for (const [name, accountsPath, vaultPath] of COPIED)
    test(`appd-acc F4 ${name} is the same code in Accounts and in the Vault`, () => {
      const ours = declared(accountsPath, name);
      const theirs = declared(vaultPath, name);
      // Declared once in each file: a second declaration of the name would make "the copy" ambiguous.
      expect({ side: 'accounts', count: ours.length }).toEqual({ side: 'accounts', count: 1 });
      expect({ side: 'vault', count: theirs.length }).toEqual({ side: 'vault', count: 1 });
      expect(ours[0]?.length).toBeGreaterThan(10);
      expect(ours[0]).toBe(theirs[0]);
    });

  test('appd-acc F4 the comparison sees a change, and ignores comments and layout', () => {
    expect(code('function f(a) { if (a.covered === true) return "x"; return undefined; }')).not.toBe(
      code('function f(a) { return undefined; }'),
    );
    expect(code('function f(a, b,) {\n  // why\n  return a; /* too */\n}')).toBe(
      code('function f(a, b) { return a; }'),
    );
  });
});
