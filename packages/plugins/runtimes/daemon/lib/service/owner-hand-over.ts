/**
 * The setup import's hand-over of the components another plugin owns (MCP servers, skills, settings): composing what
 * Runtimes' own files hold without them, and, at the apply, giving each to its owner and reporting what each answered.
 *
 * It is NOT all-or-none across owners (owner decision !A525 item 10): one owner's refusal never stops another owner, and
 * never stops Runtimes' own files, which still land together. A refused component is reverted out of the model Runtimes
 * then applies, and out of every profile that named it.
 */
import type { AccountModel } from '../account/schema.ts';
import {
  type ComponentWriter,
  type OwnerComponentWrite,
  ownerReferences,
  ownerWrites,
  revertComponents,
  withComponentsOf,
} from '../account/owner-components.ts';
import type { FleetDocumentWrite } from '../provisioning.ts';

/** What an import composed for the components another plugin owns. */
export interface OwnedComponents {
  readonly writes: readonly OwnerComponentWrite[];
  /** The model and documents to apply when the owners refused these references: those are left out. */
  rebuild(
    refused: ReadonlySet<string>,
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
  readonly documents: (model: AccountModel) => Promise<readonly FleetDocumentWrite[]>;
}): Promise<{ readonly documents: readonly FleetDocumentWrite[]; readonly owners?: OwnedComponents }> {
  const { before, model } = input;
  const owned = input.enabled ? ownerReferences(before, model) : [];
  if (owned.length === 0) return { documents: await input.documents(model) };
  return {
    documents: await input.documents(withComponentsOf(model, before, owned)),
    owners: {
      writes: ownerWrites(before, model, input.assetText),
      rebuild: async refused => {
        const left = owned.filter(({ kind, name }) => refused.has(`${kind}/${name}`));
        const kept = owned.filter(({ kind, name }) => !refused.has(`${kind}/${name}`));
        const reverted = revertComponents(model, before, left);
        return { model: reverted, documents: await input.documents(withComponentsOf(reverted, before, kept)) };
      },
    },
  };
}

/** The answer to a hand-over: what to apply, the owner files that really landed, and the sentences that name each. */
export interface HandOver {
  readonly applied: { readonly model: AccountModel; readonly documents: readonly FleetDocumentWrite[] };
  readonly landed: readonly string[];
  readonly sentences: readonly string[];
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
}): Promise<HandOver> {
  const { writer, owners, applied } = input;
  if (owners === undefined || writer === undefined || owners.writes.length === 0) {
    return { applied, landed: [], sentences: [] };
  }
  const values = input.secretValues.filter(value => value.length > 0);
  const say = (reason: string): string => {
    const clean = values.reduce((text, value) => text.split(value).join('***'), reason);
    return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
  };
  const written: string[] = [];
  const held: string[] = [];
  const refused: { readonly file: string; readonly reason: string }[] = [];
  const left = new Set<string>();
  for (const write of owners.writes) {
    const answer =
      write.text === undefined
        ? ({ outcome: 'refused', reason: write.problem ?? 'it could not be made' } as const)
        : await writer.put({ ...write, text: write.text });
    if (answer.outcome === 'written') written.push(write.file);
    else if (answer.outcome === 'held') held.push(write.file);
    else {
      refused.push({ file: write.file, reason: say(answer.reason) });
      left.add(write.reference);
    }
  }
  return {
    applied: left.size === 0 ? applied : await owners.rebuild(left),
    landed: written,
    sentences: [
      ...(written.length === 0 ? [] : [`Written by the parts that own them: ${written.join(', ')}.`]),
      ...(held.length === 0 ? [] : [`Held until you confirm: ${held.join(', ')}.`]),
      ...(refused.length === 0
        ? []
        : [`Not written: ${refused.map(entry => `${entry.file} (${entry.reason})`).join('; ')}.`]),
    ],
  };
}
