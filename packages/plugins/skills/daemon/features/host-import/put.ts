/**
 * Skills' side of the setup import (r9 A5): the `put` Runtimes hands an imported `skills` component to
 * (`ProfileComponentSource.put`), so Skills writes its OWN `config/skills/<name>.yaml` and Runtimes never does.
 *
 * What the owner decides here, before the kernel's config writer decides the rest (schema, raw-secret refusal, hold):
 *  - an item is CREATED, never replaced: a name that is taken is refused ("an import never replaces a component it did not
 *    make"), and the write is pinned to "no file yet" so a file that appears in between is never overwritten;
 *  - every skill folder the item names must be a folder name a harness can load and the installed store can hold
 *    (`usableSkillName`: never a dot-folder such as `.system`, never a path), and an item names at most
 *    {@link MAX_IMPORTED_SKILLS} folders;
 *  - the document is bounded ({@link MAX_DOCUMENT_BYTES}) and is a JSON mapping.
 *
 * The skill FOLDERS are not carried here: Runtimes' provisioner copies each into `<fleet>/assets/skills/<item>`, which is
 * this plugin's own `installed/<name>/` tree (links and non-text files are skipped there, `setup-files.ts`). This file
 * writes only the item that selects them, so it holds no file text and no value.
 */
import type { ComponentPutResult } from '@ferretry/plugin-runtimes/contract';
import { ITEM_NAME_PATTERN } from '@ferretry/std';
import { usableSkillName } from '../../lib/skill-store.ts';

/** The most skill folders one imported item may name (the installed store's own file count bound). */
export const MAX_IMPORTED_SKILLS = 200;
/** The largest document an import hands over: a selection of names is small, so anything bigger is not one. */
export const MAX_DOCUMENT_BYTES = 64 * 1024;
/** The longest item name (the schema's safe-name bound for the folders it names). */
const MAX_NAME_LENGTH = 64;

/** What `kernel.config.write` answers, as far as this module reads it (names and rules, never a value). */
export type SkillsItemWrite =
  | { readonly kind: 'written' }
  | { readonly kind: 'held' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'refused'; readonly issues: readonly { readonly path: string; readonly message: string }[] };

export interface SkillsImportDeps {
  /** Whether an item of this name is in effect. */
  has(name: string): boolean;
  /** Writes `config/skills/<name>.yaml` as a NEW file (`ifMatch: 'absent'`) through the kernel's config writer. */
  create(name: string, text: string): Promise<SkillsItemWrite>;
}

const refuse = (reason: string): ComponentPutResult => ({ ok: false, reason });

/** The skill folder names a document names, or why it cannot be one. */
function itemsOf(document: unknown): { readonly items: readonly string[] } | { readonly reason: string } {
  if (typeof document !== 'object' || document === null || Array.isArray(document))
    return { reason: 'the skills selection is not a mapping' };
  const { items } = document as { readonly items?: unknown };
  if (!Array.isArray(items) || items.length === 0) return { reason: 'the skills selection names no skill' };
  if (items.length > MAX_IMPORTED_SKILLS)
    return { reason: `the skills selection names more than ${MAX_IMPORTED_SKILLS} skills` };
  const names: string[] = [];
  for (const entry of items as unknown[]) {
    if (typeof entry !== 'string' || !usableSkillName(entry))
      return { reason: 'a skill in the selection has a folder name Ferretry cannot use' };
    names.push(entry);
  }
  return { items: names };
}

/** The sentence for a refused write: where and what the rule says, never the value that broke it. */
const sentence = (issues: SkillsItemWrite & { readonly kind: 'refused' }): string => {
  const first = issues.issues[0];
  return first === undefined
    ? 'the skills selection was refused'
    : `the skills selection was refused: ${first.message}`;
};

export function skillsImportPut(
  deps: SkillsImportDeps,
): (name: string, documentText: string) => Promise<ComponentPutResult> {
  return async (name, documentText) => {
    if (!ITEM_NAME_PATTERN.test(name) || name.length > MAX_NAME_LENGTH)
      return refuse('the name cannot be used for a skills selection');
    if (new TextEncoder().encode(documentText).byteLength > MAX_DOCUMENT_BYTES)
      return refuse('the skills selection is too large');
    let document: unknown;
    try {
      document = JSON.parse(documentText);
    } catch {
      return refuse('the skills selection is not a readable document');
    }
    const found = itemsOf(document);
    if ('reason' in found) return refuse(found.reason);
    if (deps.has(name)) return refuse(`a skills selection named "${name}" already exists, so it was not replaced`);
    const answered = await deps.create(name, documentText);
    switch (answered.kind) {
      case 'written':
        return { ok: true };
      case 'held':
        return { ok: true, held: true };
      case 'conflict':
        return refuse(`a skills selection named "${name}" appeared meanwhile, so it was not replaced`);
      case 'refused':
        return refuse(sentence(answered));
    }
  };
}
