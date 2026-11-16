import { z } from 'zod';
import { PasteRuleSchema, PasteRuleSettingsSchema } from '../../../contract/routes/index.ts';
import type { PasteRuleDocument, PasteRuleStore } from '../../lib/secure-copy/rules.ts';
import type { StateDocument } from '../state-document.ts';

const RulesDocumentSchema = z.strictObject({
  v: z.literal(1),
  rules: z.array(PasteRuleSchema),
  settings: PasteRuleSettingsSchema,
});

/**
 * The owner's pre-approval rules, `state/accounts/copy-rules.json`: routes and counts, never a value. Written
 * atomically. A document that does not parse is an ERROR, not an empty store: the service then holds no rules,
 * so every paste asks the owner. The owner's next change writes a fresh document over the damaged one: that can
 * only drop approvals, never add one.
 */
export class FilePasteRuleStore implements PasteRuleStore {
  constructor(private readonly document: StateDocument) {}

  async read(): Promise<PasteRuleDocument | undefined> {
    const body = await this.document.read();
    if (body === undefined) return undefined;
    const document = RulesDocumentSchema.parse(body);
    return { rules: document.rules, settings: document.settings };
  }

  async write(document: PasteRuleDocument): Promise<void> {
    await this.document.write(RulesDocumentSchema.parse({ v: 1, rules: document.rules, settings: document.settings }));
  }
}
