/**
 * What a set of config documents (`ConfigPort.writeAll`) comes to, decided from each document's own verdict — the one
 * rule the real writer (`./service.ts`) and the testing host both apply, so the two can never disagree about which
 * document a refusal names, when a set is held, or what the held sentence says.
 *
 * Each writer checks every document its own way (the real one against the disk and the accepted record, the testing
 * host against its in-memory world) and hands the verdicts here IN THE SET'S ORDER:
 *
 * 1. A document refused or stale decides the set: the FIRST one, in order, is the answer (`refused` / `conflict`). A
 *    refusal beats a hold, because nothing would be written either way and a refusal is the one the caller can fix.
 * 2. Otherwise the loosening judgement runs ({@link judgeSet}): a document whose edit adds a `${secret:NAME}` is held
 *    with no judge asked (nobody but the owner makes that change, NN2); otherwise the judge is asked about each
 *    loosening document in order, and the first it holds stops the asking. Any held document holds the whole set.
 * 3. Otherwise every document is written.
 *
 * Pure and total: the judge is the caller's, asked through `ask`.
 */
import type { ConfigDocumentRef, ConfigWriteAllOutcome, ConfigWriteIssue } from '../../contract/ports.ts';

type Refusal = Extract<ConfigWriteAllOutcome, { readonly kind: 'refused' }>;

/** One document, checked: refused, stale, or ready to be judged with what it would loosen. */
export type DocumentVerdict =
  | Refusal
  | Extract<ConfigWriteAllOutcome, { readonly kind: 'conflict' }>
  | {
      readonly kind: 'ready';
      readonly document: ConfigDocumentRef;
      readonly removal: boolean;
      /** What the edit loosens against the version in effect (the def's own `loosens`), the added references included. */
      readonly loosens: readonly string[];
      /** The sentences of `${secret:NAME}` references this edit adds (only an untrusted writer's count). */
      readonly added: readonly string[];
    };

type Ready = Extract<DocumentVerdict, { readonly kind: 'ready' }>;

/** The first refused or stale document, in order, or `undefined` when every one is ready. */
export function firstStop(verdicts: readonly DocumentVerdict[]): Exclude<DocumentVerdict, Ready> | undefined {
  return verdicts.find((verdict): verdict is Exclude<DocumentVerdict, Ready> => verdict.kind !== 'ready');
}

/** The set's loosening judgement: which documents are held, and what each one put into effect loosened. */
export interface SetJudgement {
  readonly held: readonly (ConfigDocumentRef & { readonly sentences: readonly string[] })[];
  /** Per document, in order: what it loosened that the judge let into effect (empty for a held set). */
  readonly loosened: readonly (readonly string[])[];
}

/**
 * Judges every ready document as a single write is judged (`writeLocked`): an added reference holds with no judge
 * asked; a loosening is put into effect only when `ask` says this call may. A reference added anywhere holds the set
 * before ANY judge is asked, so a step-up proof the judge would claim is never spent on a set that is held anyway; the
 * first document the judge holds stops the asking for the same reason, and the documents after it are not named
 * (nobody judged them).
 */
export function judgeSet(ready: readonly Ready[], ask: (document: Ready) => boolean): SetJudgement {
  const withReferences = ready.filter(document => document.added.length > 0);
  if (withReferences.length > 0) return { held: withReferences.map(heldOf), loosened: ready.map(() => []) };
  const loosened: (readonly string[])[] = [];
  for (const document of ready) {
    if (document.loosens.length === 0) {
      loosened.push([]);
      continue;
    }
    if (!ask(document)) return { held: [heldOf(document)], loosened: ready.map(() => []) };
    loosened.push(document.loosens);
  }
  return { held: [], loosened };
}

const heldOf = (document: Ready): ConfigDocumentRef & { readonly sentences: readonly string[] } => ({
  ...document.document,
  sentences: document.loosens,
});

/**
 * The held set's sentence: which document(s) loosen, that the set is held, and that nothing in it was written. Names
 * the files and what widened, never a value.
 */
function heldSetSentence(
  held: readonly (ConfigDocumentRef & { readonly sentences: readonly string[] })[],
  total: number,
): string {
  const named = held.map(document => `${document.path} (${document.sentences.join('; ')})`).join(', ');
  const verb = held.length === 1 ? 'loosens' : 'loosen';
  const count = total === 1 ? 'its one document' : `its ${total} documents`;
  return (
    `${named} ${verb} what this machine may spend or do, so the whole set is held for the owner: none of ${count} ` +
    'was written and nothing in it took effect. Ask the owner to make this change.'
  );
}

/** The held outcome of a set. */
export function heldSet(judgement: SetJudgement, total: number): ConfigWriteAllOutcome {
  return { kind: 'held', held: judgement.held, sentence: heldSetSentence(judgement.held, total) };
}

/** The first file a set names twice, or `undefined`. */
export function repeatedDocument(documents: readonly ConfigDocumentRef[]): ConfigDocumentRef | undefined {
  const seen = new Set<string>();
  for (const document of documents) {
    if (seen.has(document.path)) return document;
    seen.add(document.path);
  }
  return undefined;
}

/** A refusal of one document (or of the set at that document) as the outcome says it. */
export function refusedDocument(
  reason: Refusal['reason'],
  document: ConfigDocumentRef | undefined,
  issues: readonly ConfigWriteIssue[] = [],
): Refusal {
  return { kind: 'refused', reason, ...(document === undefined ? {} : { document }), issues };
}

/** Why a set naming one file twice is refused. */
export const DUPLICATE_ISSUE = (path: string): ConfigWriteIssue => ({
  path,
  message: `${path} is named twice in one set`,
  fix: 'name each file once, with the whole edit it needs',
});

/** Why a set touching a file with an edit held for the owner is refused. */
export const ALREADY_HELD_ISSUE = (path: string): ConfigWriteIssue => ({
  path,
  message: `${path} has an edit held for the owner`,
  fix: 'confirm or discard the held edit first, then make the change again',
});

/**
 * Why a write, removal or set touching a file that cannot be read is refused — the one sentence every writer says
 * (`./service.ts`): what is there is not a config file the kernel reads (a link, not a regular file, over the size
 * cap, or not UTF-8 text), so a write over it would destroy what it holds.
 */
export const UNREADABLE_ISSUE = (path: string): ConfigWriteIssue => ({
  path,
  message: `${path} cannot be read (a link, not a regular file, larger than a config file may be, or not UTF-8 text), so nothing was written over it`,
  fix: 'replace the file with an ordinary UTF-8 one, then make the change again',
});
