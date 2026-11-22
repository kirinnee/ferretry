/**
 * The setup import's hand-over of the components another plugin owns (MCP servers, skills, settings): composing what
 * Runtimes' own files hold without them, and, at the apply, giving each to its owner and reporting what each answered.
 *
 * It is NOT all-or-none across owners (owner decision !A525 item 10): one owner's refusal never stops another owner, and
 * never stops Runtimes' own files, which still land together. A refused component is reverted out of the model Runtimes
 * then applies, and out of every profile that named it.
 */
import { type ImportPlan } from '../account/import.ts';
import { mergeImportRecord } from '../account/import-plan.ts';
import type { AccountModel, LayerReferenceText } from '../account/schema.ts';
import {
  type ComponentWriter,
  type OwnerComponentWrite,
  ownerReferences,
  ownerWrites,
  revertComponents,
  skillAssetPrefix,
  withComponentsOf,
  withEffective,
} from '../account/owner-components.ts';
import type { FleetDocumentWrite } from '../provisioning.ts';
import { FleetCatalogRefusal } from './catalog-service.ts';
import { configurationLanded } from './failed-apply.ts';

/** The references (`kind/name`) the owners did not take into effect: refused outright, or written but held for the owner. */
export interface NotInEffect {
  readonly refused: ReadonlySet<string>;
  readonly held: ReadonlySet<string>;
  /** The owner's own items each reference's write created (by reference), for the import record to keep. */
  readonly created?: ReadonlyMap<string, readonly string[]>;
  /** The etag each of those files was written at (by reference, then item name), so a later update can tell a hand-made one. */
  readonly etags?: ReadonlyMap<string, Readonly<Record<string, string>>>;
}

const NOTHING_HELD: NotInEffect = { refused: new Set(), held: new Set() };

/** What an import composed for the components another plugin owns. */
export interface OwnedComponents {
  readonly writes: readonly OwnerComponentWrite[];
  /**
   * The model and documents to apply once the owners answered: a refused reference is left out of both and out of every
   * profile that named it; a held one stays in the documents (confirming it completes them) and is left to the caller's
   * reading of what is in effect. `documents` is told what is not in effect so the import record claims no more.
   */
  rebuild(
    outcome: NotInEffect,
  ): Promise<{ readonly model: AccountModel; readonly documents: readonly FleetDocumentWrite[] }>;
}

/**
 * The documents Runtimes' own files take (the owners' components left as the machine has them) and what is handed over.
 * `enabled` is whether an owner door exists at all; without one nothing is split off and the change is composed as before.
 */
export async function composeOwned(input: {
  readonly before: AccountModel;
  readonly model: AccountModel;
  readonly enabled: boolean;
  readonly assetText: (file: string) => string | undefined;
  readonly assetFiles?: (prefix: string) => readonly { readonly path: string; readonly content: string }[];
  readonly documents: (model: AccountModel, outcome: NotInEffect) => Promise<readonly FleetDocumentWrite[]>;
  /** The references (`kind/name`) of accepted updates: handed over even when their model value did not move. */
  readonly touched?: readonly string[];
  /** The owner's own items an earlier import created through a component, by reference (the import record's). */
  readonly ownedOf?: (reference: string) => readonly string[];
  /** The etag an earlier import left on each of the owner's files through a component, by reference (the record's). */
  readonly etagsOf?: (reference: string) => Readonly<Record<string, string>>;
}): Promise<{ readonly documents: readonly FleetDocumentWrite[]; readonly owners?: OwnedComponents }> {
  const { before, model } = input;
  const owned = input.enabled ? ownerReferences(before, model, input.touched) : [];
  if (owned.length === 0) return { documents: await input.documents(model, NOTHING_HELD) };
  return {
    documents: await input.documents(withComponentsOf(model, before, owned), NOTHING_HELD),
    owners: {
      writes: ownerWrites(
        before,
        model,
        input.assetText,
        input.assetFiles,
        input.touched,
        input.ownedOf,
        input.etagsOf,
      ),
      rebuild: async outcome => {
        const left = owned.filter(({ kind, name }) => outcome.refused.has(`${kind}/${name}`));
        const kept = owned.filter(({ kind, name }) => !outcome.refused.has(`${kind}/${name}`));
        const reverted = revertComponents(model, before, left);
        return {
          model: reverted,
          documents: await input.documents(withComponentsOf(reverted, before, kept), outcome),
        };
      },
    },
  };
}

/** The answer to a hand-over: what to apply, the owner files that really landed, and the sentences that name each. */
export interface HandOver {
  readonly applied: { readonly model: AccountModel; readonly documents: readonly FleetDocumentWrite[] };
  readonly landed: readonly string[];
  readonly sentences: readonly string[];
  /** How many files an owner HELD for the owner's confirmation, and how many it refused (structured, for the log). */
  readonly held: number;
  readonly refused: number;
}

/**
 * Gives each component its owner's door, one at a time. The answer names every file written, held and refused (names, and
 * the owner's own sentence with every secret value this import carries masked and its length bounded).
 */
export async function handOver(input: {
  readonly writer: ComponentWriter | undefined;
  readonly owners: OwnedComponents | undefined;
  readonly applied: HandOver['applied'];
  readonly secretValues: readonly string[];
  /** The model the owners report in effect NOW (read again after they wrote). Only asked when an owner took something. */
  readonly inEffect: () => Promise<AccountModel>;
}): Promise<HandOver> {
  const { writer, owners, applied } = input;
  if (owners === undefined || writer === undefined || owners.writes.length === 0) {
    return { applied, landed: [], sentences: [], held: 0, refused: 0 };
  }
  const values = input.secretValues.filter(value => value.length > 0);
  const say = (reason: string): string => {
    const clean = values.reduce((text, value) => text.split(value).join('***'), reason);
    return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
  };
  const written: string[] = [];
  const held: string[] = [];
  const refused: { readonly file: string; readonly reason: string }[] = [];
  const noted: string[] = [];
  const left = new Set<string>();
  const heldReferences = new Set<string>();
  const created = new Map<string, readonly string[]>();
  const etags = new Map<string, Readonly<Record<string, string>>>();
  for (const write of owners.writes) {
    const answer =
      write.text === undefined
        ? ({ outcome: 'refused', reason: write.problem ?? 'it could not be made' } as const)
        : await writer.put({ ...write, text: write.text });
    if (answer.outcome !== 'refused') {
      (answer.outcome === 'written' ? written : held).push(write.file);
      if (answer.outcome === 'held') heldReferences.add(write.reference);
      if (answer.created !== undefined && answer.created.length > 0) created.set(write.reference, answer.created);
      if (answer.etags !== undefined) etags.set(write.reference, answer.etags);
      for (const warning of answer.warnings ?? []) noted.push(`${write.file} (${say(warning)})`);
      if (write.skipped !== undefined)
        noted.push(`${write.file} (hidden files not handed over: ${say(write.skipped.join(', '))})`);
    } else {
      refused.push({ file: write.file, reason: say(answer.reason) });
      left.add(write.reference);
    }
  }
  const rebuilt =
    left.size === 0 && heldReferences.size === 0 && created.size === 0 && etags.size === 0
      ? applied
      : await owners.rebuild({ refused: left, held: heldReferences, created, etags });
  // The fleet is built from what the owners report in effect, never from what the import asked for: a held component
  // is not in effect yet, an owner may have written less than it was given, and a prior version stays active.
  const taken = owners.writes.filter(write => !left.has(write.reference));
  const reported =
    taken.length === 0
      ? undefined
      : await input.inEffect().catch((error: unknown) => {
          throw new FleetCatalogRefusal(
            'fleet_change_failed',
            `what is now in effect could not be read (${error instanceof Error ? error.message : String(error)}), so no runtime was generated${written.length === 0 ? '' : `; ${configurationLanded(written)}`}`,
          );
        });
  const effective =
    reported === undefined
      ? rebuilt.model
      : withEffective(
          rebuilt.model,
          reported,
          taken.map(({ kind, name }) => ({ kind, name })),
        );
  // An owner may answer "written" for a document and keep the component itself out of effect (Codex's settings for a
  // profile-only import writes only the profile items). The saved profile files must not name what is not in effect either,
  // or the next reload fails on the missing item: they are composed again with it left out. A HELD one stays in the files
  // (confirming it completes them).
  const vanished =
    reported === undefined
      ? []
      : taken.filter(
          write => !heldReferences.has(write.reference) && reported.components[write.kind][write.name] === undefined,
        );
  const documents =
    vanished.length === 0
      ? rebuilt.documents
      : (
          await owners.rebuild({
            refused: new Set([...left, ...vanished.map(write => write.reference)]),
            held: heldReferences,
            created,
            etags,
          })
        ).documents;
  return {
    applied: { model: effective, documents },
    landed: written,
    held: held.length,
    refused: refused.length,
    sentences: [
      ...(written.length === 0 ? [] : [`Written by the parts that own them: ${written.join(', ')}.`]),
      ...(held.length === 0 ? [] : [`Held until you confirm: ${held.join(', ')}.`]),
      ...(noted.length === 0 ? [] : [`Written with a warning: ${noted.join('; ')}.`]),
      ...(refused.length === 0
        ? []
        : [`Not written: ${refused.map(entry => `${entry.file} (${entry.reason})`).join('; ')}.`]),
    ],
  };
}

/**
 * The text of the import record after an apply, claiming only what took effect: an accepted update an owner refused or held stays
 * as it was (so the next scan offers it again), and a component an owner refused is not recorded as imported.
 */
export function recordText(
  plan: ImportPlan,
  updates: readonly { readonly reference: LayerReferenceText }[],
  outcome: NotInEffect,
): string {
  const offered = new Set<string>(updates.map(update => update.reference));
  const merged = mergeImportRecord(
    plan,
    updates
      .map(update => update.reference)
      .filter(reference => !outcome.refused.has(reference) && !outcome.held.has(reference)),
  );
  // What the owners created is kept with the entry, beside what an earlier import created, so a later update replaces only those.
  const components = Object.fromEntries(
    Object.entries(merged.components)
      .filter(([reference]) => offered.has(reference) || !outcome.refused.has(reference))
      .map(([reference, entry]) => {
        const owned = [...new Set([...(entry.owned ?? []), ...(outcome.created?.get(reference) ?? [])])];
        const stamped = { ...entry.etags, ...outcome.etags?.get(reference) };
        const withOwned = owned.length === 0 ? entry : { ...entry, owned };
        return [reference, Object.keys(stamped).length === 0 ? withOwned : { ...withOwned, etags: stamped }];
      }),
  );
  return `${JSON.stringify({ ...merged, components }, null, 2)}\n`;
}

/**
 * `assets` without what an owner is handed: the body a settings component was made from (it only composes the owner's
 * document; written under the fleet it would outlive an owner's refusal, raw secrets included) and the files of each
 * skill item (the owner installs them into its own store, with its own bounds).
 */
export function withoutHandedBodies<T extends { readonly path: string }>(
  assets: readonly T[],
  before: AccountModel,
  model: AccountModel,
  touched: readonly string[] = [],
): readonly T[] {
  const handed = ownerReferences(before, model, touched);
  const bodies = new Set<string>(
    handed.flatMap(({ kind, name }) => {
      const file = kind === 'settings' ? model.components.settings[name]?.file : undefined;
      return file === undefined ? [] : [file];
    }),
  );
  const folders = handed.flatMap(({ kind, name }) =>
    kind === 'skills' ? (model.components.skills[name]?.items ?? []).map(skillAssetPrefix) : [],
  );
  return assets.filter(asset => !bodies.has(asset.path) && !folders.some(folder => asset.path.startsWith(folder)));
}
