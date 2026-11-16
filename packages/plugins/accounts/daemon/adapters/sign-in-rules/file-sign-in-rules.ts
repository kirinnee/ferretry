import { type SignInRulesDocument, SignInRulesDocumentSchema } from '../../../contract/routes/index.ts';
import type { SignInRuleStore } from '../../lib/sign-in-rules/service.ts';
import type { StateDocument } from '../state-document.ts';

/**
 * THE OWNER'S STANDING SIGN-IN RULES, `state/accounts/sign-in-rules.json` (directory 0700, file 0600, written
 * atomically by the kernel): each rule's signed body, its kept passkey assertion and the unsigned overlay. Never a value.
 *
 * STRICT: the whole document is parsed with `SignInRulesDocumentSchema` (`v: 1`, no unknown key, one rule per id and per
 * sign-in). A file that is unreadable, truncated or does not parse is an ERROR, never an empty store: the service then
 * holds ZERO rules, so every sign-in asks. Before the owner's next write, {@link setAside} keeps the damaged file beside
 * the fresh one: an approval can only be dropped, never added, and nothing is deleted.
 */
export class FileSignInRuleStore implements SignInRuleStore {
  constructor(private readonly document: StateDocument) {}

  async read(): Promise<SignInRulesDocument | undefined> {
    const body = await this.document.read();
    if (body === undefined) return undefined;
    return SignInRulesDocumentSchema.parse(body);
  }

  async write(document: SignInRulesDocument): Promise<void> {
    await this.document.write(SignInRulesDocumentSchema.parse(document));
  }

  async setAside(stamp: string): Promise<void> {
    await this.document.setAside(`damaged-${stamp.replaceAll(/[^0-9A-Za-z-]/gu, '-')}`);
  }
}
