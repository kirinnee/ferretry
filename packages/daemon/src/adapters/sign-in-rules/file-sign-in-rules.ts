import { join } from 'node:path';
import { type SignInRulesDocument, SignInRulesDocumentSchema } from '@ferretry/protocol';
import type { FileSystemPort, SignInRuleStore } from '../../lib/index.ts';

/** The file's name in `<state>/accounts/`. */
export const SIGN_IN_RULES_DOCUMENT = 'sign-in-rules.json';

/**
 * THE OWNER'S STANDING SIGN-IN RULES, `<state>/accounts/sign-in-rules.json` (directory 0700, file 0600, written
 * atomically): each rule's signed body, its kept passkey assertion and the unsigned overlay. Never a value.
 *
 * STRICT: the whole document is parsed with `SignInRulesDocumentSchema` (`v: 1`, no unknown key, one rule per id and per
 * sign-in). A file that is unreadable, truncated or does not parse is an ERROR, never an empty store: the service then
 * holds ZERO rules, so every sign-in asks. Before the owner's next write, {@link setAside} copies the damaged text to
 * `sign-in-rules.json.damaged-<stamp>` beside it and the fresh document replaces it: an approval can only be dropped,
 * never added, and nothing is deleted.
 */
export class FileSignInRuleStore implements SignInRuleStore {
  private readonly file: string;

  constructor(
    private readonly directory: string,
    private readonly files: Pick<FileSystemPort, 'readText' | 'writeTextAtomic' | 'ensureDirectory'>,
  ) {
    this.file = join(directory, SIGN_IN_RULES_DOCUMENT);
  }

  async read(): Promise<SignInRulesDocument | undefined> {
    const text = await this.files.readText(this.file);
    if (text === undefined) return undefined;
    return SignInRulesDocumentSchema.parse(JSON.parse(text));
  }

  async write(document: SignInRulesDocument): Promise<void> {
    await this.files.ensureDirectory(this.directory, 0o700);
    const written = SignInRulesDocumentSchema.parse(document);
    await this.files.writeTextAtomic(this.file, `${JSON.stringify(written)}\n`);
  }

  async setAside(stamp: string): Promise<void> {
    const text = await this.files.readText(this.file);
    if (text === undefined) return;
    await this.files.ensureDirectory(this.directory, 0o700);
    await this.files.writeTextAtomic(`${this.file}.damaged-${stamp.replaceAll(/[^0-9A-Za-z-]/gu, '-')}`, text);
  }
}
