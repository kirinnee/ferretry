import { join } from 'node:path';
import { type PasteRule, PasteRuleSchema } from '@ferretry/protocol';
import { z } from 'zod';
import type { FileSystemPort, PasteRuleStore } from '../../lib/index.ts';

const RulesDocumentSchema = z.strictObject({ v: z.literal(1), rules: z.array(PasteRuleSchema) });

/**
 * The owner's pre-approval rules, `<state>/secure-copy/rules.json`: routes and counts, never a value. Written
 * atomically. A document that does not parse is an ERROR, not an empty store: the service then holds no rules,
 * so every paste asks the owner, rather than reading damage as "nothing approved" and overwriting what is there.
 */
export class FilePasteRuleStore implements PasteRuleStore {
  private readonly file: string;

  constructor(
    private readonly directory: string,
    private readonly files: Pick<FileSystemPort, 'readText' | 'writeTextAtomic' | 'ensureDirectory'>,
  ) {
    this.file = join(directory, 'rules.json');
  }

  async read(): Promise<readonly PasteRule[] | undefined> {
    const text = await this.files.readText(this.file);
    if (text === undefined) return undefined;
    return RulesDocumentSchema.parse(JSON.parse(text)).rules;
  }

  async write(rules: readonly PasteRule[]): Promise<void> {
    await this.files.ensureDirectory(this.directory, 0o700);
    await this.files.writeTextAtomic(this.file, `${JSON.stringify(RulesDocumentSchema.parse({ v: 1, rules }))}\n`);
  }
}
