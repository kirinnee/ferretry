import { join } from 'node:path';
import { DEFAULT_PASTE_RULE_SETTINGS, PasteRuleSchema, PasteRuleSettingsSchema } from '@ferretry/protocol';
import { z } from 'zod';
import type { FileSystemPort, PasteRuleDocument, PasteRuleStore } from '../../lib/index.ts';

/** `settings` is optional on disk: a file written before it existed holds the defaults (profile targets off). */
const RulesDocumentSchema = z.strictObject({
  v: z.literal(1),
  rules: z.array(PasteRuleSchema),
  settings: PasteRuleSettingsSchema.optional(),
});

/**
 * The owner's pre-approval rules, `<state>/secure-copy/rules.json`: routes and counts, never a value. Written
 * atomically. A document that does not parse is an ERROR, not an empty store: the service then holds no rules,
 * so every paste asks the owner. The owner's next change writes a fresh document over the damaged one: that can
 * only drop approvals, never add one.
 */
export class FilePasteRuleStore implements PasteRuleStore {
  private readonly file: string;

  constructor(
    private readonly directory: string,
    private readonly files: Pick<FileSystemPort, 'readText' | 'writeTextAtomic' | 'ensureDirectory'>,
  ) {
    this.file = join(directory, 'rules.json');
  }

  async read(): Promise<PasteRuleDocument | undefined> {
    const text = await this.files.readText(this.file);
    if (text === undefined) return undefined;
    const document = RulesDocumentSchema.parse(JSON.parse(text));
    return { rules: document.rules, settings: document.settings ?? DEFAULT_PASTE_RULE_SETTINGS };
  }

  async write(document: PasteRuleDocument): Promise<void> {
    await this.files.ensureDirectory(this.directory, 0o700);
    const written = RulesDocumentSchema.parse({ v: 1, rules: document.rules, settings: document.settings });
    await this.files.writeTextAtomic(this.file, `${JSON.stringify(written)}\n`);
  }
}
