/**
 * Skills' side of the setup import (r9 A5): the `put` Runtimes hands an imported `skills` component to
 * (`ProfileComponentSource.put`), so Skills lands the skills in its OWN store and writes its OWN `config/skills/<name>.yaml`;
 * Runtimes does neither.
 *
 * What the owner decides here, before the kernel's config writer decides the rest (schema, raw-secret refusal, hold):
 *  - an item is CREATED, never replaced: a name that is taken is refused ("an import never replaces a component it did not
 *    make"), and the write is pinned to "no file yet" so a file that appears in between is never overwritten. The ONE
 *    exception is an update the person accepted (`options.replace`): the item is then replaced, pinned to the file's
 *    current etag (so a file that moved meanwhile is a refusal), the skills it names that are new are installed, and the
 *    skills an import installed earlier (`options.owned`) are rewritten with the files now handed over, but ONLY while the
 *    folder still holds what the import last wrote (the store's content digest of it): a folder the person deleted and made
 *    again, or edited, is theirs. A skill that is installed but was NOT brought in by an import, or was changed since, is
 *    left exactly as it is, in a sentence. The item's write is pinned to the etag verified before any folder work;
 *  - every skill folder the item names must be a folder name a harness can load and the installed store can hold
 *    (`usableSkillName`: never a dot-folder such as `.system`, never a path), and an item names at most
 *    {@link MAX_IMPORTED_SKILLS} folders;
 *  - the document is bounded ({@link MAX_DOCUMENT_BYTES}) and is a JSON mapping;
 *  - **the skill folders land in this plugin's installed store**, the one place a launch reads them from
 *    (`installed/<skill>/`), through the store's own install and its own bounds (200 files, 256 KiB a file, 2 MiB in all,
 *    a `SKILL.md`, plain paths): everything is checked before anything is written, and a skill over a bound refuses the
 *    whole item with the reason. A skill the store already holds is left exactly as it is and said so. Runtimes hands the
 *    folders over as plain text files (`<skill>/<path>`); it reads no link and never `.system`, and nothing here follows one.
 *  - **the harness id is this plugin's own.** Runtimes names a harness `claude` or `codex`; the item's `harness` is the
 *    harness key (`claude-code`, `codex`). Runtimes' word (or the key) is accepted and the key written; any other is refused.
 *
 * Nothing here holds a value: a skill is text, and a refusal names a skill, a path and a rule, never a file's content.
 */
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import type { ComponentPutFile, ComponentPutOptions, ComponentPutResult } from '@ferretry/plugin-runtimes/contract';
import { ITEM_NAME_PATTERN } from '@ferretry/std';
import {
  type InstalledSkillFile,
  InstalledSkillExists,
  installRefusal,
  usableSkillName,
} from '../../lib/skill-store.ts';

/** The most skill folders one imported item may name (the installed store's own file count bound). */
export const MAX_IMPORTED_SKILLS = 200;
/** The largest document an import hands over: a selection of names is small, so anything bigger is not one. */
export const MAX_DOCUMENT_BYTES = 64 * 1024;
/** The longest item name (the schema's safe-name bound for the folders it names). */
const MAX_NAME_LENGTH = 64;

/** Runtimes' word for a harness, and the harness key itself, to the key a skills item carries. */
const HARNESS_KEY_OF: Readonly<Record<string, HarnessKey | undefined>> = Object.assign(Object.create(null), {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
});

/** One file of an imported skill, as Runtimes hands it over: `<skill>/<path inside the skill>` and its text. */
export type ImportedSkillFile = ComponentPutFile;

/** What `kernel.config.write` answers, as far as this module reads it (names and rules, never a value). */
export type SkillsItemWrite =
  | { readonly kind: 'written'; readonly etag: string }
  | { readonly kind: 'held'; readonly etag: string }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'refused'; readonly issues: readonly { readonly path: string; readonly message: string }[] };

/** The installed store, as far as an import needs it (so a test fakes only these). */
interface SkillsInstalledStore {
  /** Whether `installed/<skill>/` is a plain folder here. */
  holds(skill: string): Promise<boolean>;
  /**
   * Installs `files` (paths inside the skill) at `installed/<skill>/`, CREATE-ONLY (an existing skill is never replaced; it
   * throws `InstalledSkillExists`); throws a refusal that names the rule.
   */
  install(
    skill: string,
    files: readonly InstalledSkillFile[],
    options?: { readonly createOnly?: boolean; readonly stamp?: boolean },
  ): Promise<void>;
  /**
   * Whether `installed/<skill>/` still holds exactly what an import last wrote there (installed with `stamp`): a folder
   * the person deleted and made again, or edited, is not.
   */
  unchangedSinceImport(skill: string): Promise<boolean>;
  /** Removes what an install of ours wrote. */
  uninstall(skill: string): Promise<void>;
}

export interface SkillsImportDeps {
  /** Whether an item of this name is in effect. */
  has(name: string): boolean;
  /** The config etag of `config/skills/<name>.yaml` on disk right now, or `'absent'`. */
  etag(name: string): Promise<string>;
  /** Replaces `config/skills/<name>.yaml` as the person's accepted update, pinned to `etag`: the one this import verified. */
  replace(name: string, text: string, etag: string): Promise<SkillsItemWrite>;
  /** Writes `config/skills/<name>.yaml` as a NEW file (`ifMatch: 'absent'`) through the kernel's config writer. */
  create(name: string, text: string): Promise<SkillsItemWrite>;
  /** Skills' own installed store: where the folders land. */
  store: SkillsInstalledStore;
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

/** The files of one skill out of what was handed over, with the skill's own folder taken off the front of each path. */
const filesOf = (skill: string, files: readonly ImportedSkillFile[]): readonly InstalledSkillFile[] =>
  files
    .filter(file => file.path.startsWith(`${skill}/`))
    .map(file => ({ path: file.path.slice(skill.length + 1), content: file.content }));

export function skillsImportPut(
  deps: SkillsImportDeps,
): (
  name: string,
  documentText: string,
  files?: readonly ImportedSkillFile[],
  options?: ComponentPutOptions,
) => Promise<ComponentPutResult> {
  return async (name, documentText, files = [], options) => {
    const current = options?.replace === true && deps.has(name) ? await deps.etag(name) : '';
    const replacing = current !== '' && options?.etags?.[name] === current;
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
    const harness = (document as { readonly harness?: unknown }).harness;
    let text = documentText;
    if (harness !== undefined) {
      const key = typeof harness === 'string' ? HARNESS_KEY_OF[harness] : undefined;
      if (key === undefined) return refuse('the skills selection names a harness Ferretry does not know');
      text = `${JSON.stringify({ ...(document as object), harness: key }, null, 2)}\n`;
    }
    if (deps.has(name) && !replacing)
      return refuse(
        `a skills selection named "${name}" already exists and is not as an import left it, so it was not replaced`,
      );

    // Everything is checked before anything is written: one skill over a bound refuses the item, with the reason.
    const toInstall: { readonly skill: string; readonly files: readonly InstalledSkillFile[] }[] = [];
    const toRewrite: { readonly skill: string; readonly files: readonly InstalledSkillFile[] }[] = [];
    const owned = new Set(options?.owned ?? []);
    const kept: string[] = [];
    for (const skill of found.items) {
      if (await deps.store.holds(skill)) {
        if (!replacing) kept.push(`"${skill}" is already installed here, so it was left as it is`);
        else if (!owned.has(skill))
          kept.push(
            `"${skill}" is already installed here and was not brought in by an import, so it was left as it is`,
          );
        else if (!(await deps.store.unchangedSinceImport(skill)))
          kept.push(`"${skill}" was changed after the import wrote it, so it was left as it is`);
        else {
          // One an import installed and nobody changed since: its files are rewritten with what the host has now.
          const own = filesOf(skill, files);
          if (own.length === 0)
            return refuse(`the files of the skill "${skill}" were not handed over, so it was not updated`);
          const why = installRefusal(skill, own);
          if (why !== undefined) return refuse(`the skill "${skill}" was not updated: ${why}`);
          toRewrite.push({ skill, files: own });
        }
        continue;
      }
      const own = filesOf(skill, files);
      if (own.length === 0)
        return refuse(`the files of the skill "${skill}" were not handed over, so it was not imported`);
      const why = installRefusal(skill, own);
      if (why !== undefined) return refuse(`the skill "${skill}" was not imported: ${why}`);
      toInstall.push({ skill, files: own });
    }

    const landed: string[] = [];
    const undo = async (): Promise<void> => {
      for (const skill of landed) await deps.store.uninstall(skill).catch(() => undefined);
    };
    for (const { skill, files: own } of toInstall) {
      try {
        await deps.store.install(skill, own, { createOnly: true, stamp: true });
        landed.push(skill);
      } catch (error) {
        // A skill that landed between the look above and this write is the owner's: left as it is, and said so.
        if (error instanceof InstalledSkillExists) {
          kept.push(`"${skill}" is already installed here, so it was left as it is`);
          continue;
        }
        await undo();
        return refuse(
          `the skill "${skill}" was not imported: ${error instanceof Error ? error.message : 'it could not be installed'}`,
        );
      }
    }

    for (const { skill, files: own } of toRewrite) {
      try {
        await deps.store.install(skill, own, { stamp: true });
      } catch (error) {
        await undo();
        return refuse(
          `the skill "${skill}" was not updated: ${error instanceof Error ? error.message : 'it could not be installed'}`,
        );
      }
    }

    const answered = replacing ? await deps.replace(name, text, current) : await deps.create(name, text);
    const warnings = kept.length === 0 ? {} : { warnings: kept };
    const created = landed.length === 0 ? {} : { created: landed };
    const etags = answered.kind === 'written' || answered.kind === 'held' ? { etags: { [name]: answered.etag } } : {};
    switch (answered.kind) {
      case 'written':
        return { ok: true, ...warnings, ...created, ...etags };
      case 'held':
        return { ok: true, held: true, ...warnings, ...created, ...etags };
      case 'conflict':
        await undo();
        return refuse(`a skills selection named "${name}" appeared meanwhile, so it was not replaced`);
      case 'refused':
        await undo();
        return refuse(sentence(answered));
    }
  };
}
