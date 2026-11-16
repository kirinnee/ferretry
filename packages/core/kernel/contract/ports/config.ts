import type { ConfigCollectionDef, ConfigFileDef } from '../define.ts';
import type { Cancel } from './clock.ts';

/**
 * Where one declared config file stands (today's config-files entry state): `absent` (no file, nothing in effect),
 * `valid` (the file is in effect), `invalid` (the file does not check; its last good version stays in effect when
 * there is one — `inEffect: false` is a FIRST file that never checked: damage, not defaults), `held` (a loosening
 * edit waits for the owner; the tighter version stays in effect).
 */
export interface ConfigFileStatus {
  readonly state: 'absent' | 'valid' | 'invalid' | 'held';
  /** Whether some version (the file, or its last good one) is in effect. */
  readonly inEffect: boolean;
  /** Plain sentences naming what is wrong (an invalid file) or what widened (a held edit). Never a value. */
  readonly sentences: readonly string[];
}

/**
 * One file's move, as {@link ConfigPort.watchState} hears it: which collection item (`undefined` for a file), the
 * state it is in now, and its disk etag now (`'absent'` when there is no file). Never a value, never a sentence.
 */
export interface ConfigStateChange {
  readonly name?: string;
  readonly state: ConfigFileStatus['state'];
  readonly etag: string;
}

/** A whole new YAML text, or a patch of top-level keys (`undefined` removes a key); a patch keeps comments. */
export type ConfigEdit = string | { readonly patch: Readonly<Record<string, unknown>> };

/** One problem with a config text, by line, never quoting a value. */
export interface ConfigWriteIssue {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly message: string;
  /** The plain fix, when there is one. */
  readonly fix?: string;
}

/**
 * What a config write did (today's config-files contract), never thrown: `written` (in effect), `held` (written, but
 * a loosening waits for the owner — the tighter version stays in effect), `conflict` (the file moved since `ifMatch`
 * or since the last reload: an edit nobody has seen is never applied, so the caller reads again and redoes it),
 * `refused` (bad YAML, a raw secret, the schema, or not a def the caller may write).
 */
export type ConfigWriteOutcome =
  | {
      readonly kind: 'written';
      readonly etag: string;
      readonly loosened: readonly string[];
      /**
       * Only on a PATCH ({@link ConfigPort.write}, {@link ConfigPort.writeAsCaller} or {@link ConfigPort.writeAsOwner})
       * that left ANOTHER edit of the same file held: the caller's change is in effect and the held edit (made to both versions, still held)
       * waits for the owner.
       */
      readonly stillHeld?: { readonly id: string; readonly sentences: readonly string[] };
    }
  | { readonly kind: 'held'; readonly etag: string; readonly id: string; readonly sentences: readonly string[] }
  | { readonly kind: 'conflict' }
  | {
      readonly kind: 'refused';
      readonly reason: 'yaml' | 'raw_secret' | 'schema' | 'not_declared' | 'bad_name' | 'not_a_mapping';
      readonly issues: readonly ConfigWriteIssue[];
    }
  /**
   * Only from {@link ConfigPort.remove} with `refuseIfHeld`: the removal loosens and this call's judge did not let it
   * into effect, so it would have been held. Nothing was touched: the file is still in effect, nothing is held.
   */
  | {
      readonly kind: 'refused';
      readonly reason: 'would_hold';
      /** Always empty: nothing is wrong with the file; `sentences` say what the removal would loosen. */
      readonly issues: readonly ConfigWriteIssue[];
      readonly sentences: readonly string[];
    };

/** Its declared config files and collections, parsed, live (§7.2). */
export interface ConfigPort {
  file<Shape>(def: ConfigFileDef<Shape>): Shape | undefined;
  collection<Shape>(def: ConfigCollectionDef<Shape>): ReadonlyMap<string, Shape>;
  watch(def: ConfigFileDef<any> | ConfigCollectionDef<any>, listener: () => void): Cancel;
  /**
   * Fires when one of THIS def's files moves on DISK or in state, which {@link watch} does not hear unless the version
   * in effect moved too: an edit written or held for the owner, a held edit confirmed or discarded, a file that broke
   * (`invalid`, its last good version still in effect) or was fixed, one removed (`absent`). One call per file that
   * moved (a collection's item named by `name`), after the reload that saw it; the first load is the baseline, never a
   * change. The change carries the file's state and its disk etag (the etag a write answers), NEVER its text, a value
   * or a sentence ({@link ConfigFileStatus.sentences} stay with {@link fileState}). Another plugin's def throws, as
   * {@link watch} does. A listener that throws is logged and never reaches the writer.
   */
  watchState(def: ConfigFileDef<any> | ConfigCollectionDef<any>, listener: (change: ConfigStateChange) => void): Cancel;
  /** Tells an absent file from an invalid one (and a held one); `name` picks a collection item. */
  fileState(def: ConfigFileDef<any> | ConfigCollectionDef<any>, name?: string): ConfigFileStatus;
  /**
   * The disk etag of ONE of ITS OWN declared files right now (`name` picks a collection item): the very etag
   * {@link write}, {@link writeAsOwner}, {@link remove} and {@link writeAll} compare an `ifMatch` with, or `'absent'`
   * when there is no file. It is the etag ONLY — never the file's text, a value or a sentence — so a plugin that must
   * pin an edit to what a caller read (a profile's layers, say) can do it without being handed the file.
   *
   * Read from the disk when asked, not from the version in effect. Another plugin's def is refused (it throws, as
   * {@link file} does); so is a name that is no file of this def (a name given for a single file, none or a name
   * outside the collection's grammar for a collection).
   */
  etag(def: ConfigFileDef<any> | ConfigCollectionDef<any>, name?: string): Promise<string>;
  /**
   * Writes one of ITS OWN declared files (`name`: the collection item, `undefined` for a file) through the one
   * kernel config writer Gate's config route also uses: only the changed keys are edited, a raw secret is refused,
   * the last good version is kept, and a loosening is put into effect only when Gate's judge
   * (`Admission.judgeConfigWrite`) says this call may; otherwise it is HELD for the owner. Another plugin's def is
   * refused `not_declared`.
   *
   * A PATCH of a file with an edit held for the owner is made to BOTH versions, as {@link writeAsOwner} makes one: the
   * caller's change is judged against the version in effect alone, and the held edit, changed, stays held (answered as
   * `stillHeld`), so a caller who may confirm a loosening never confirms the held one with it. A WHOLE text is the
   * caller's whole text and replaces the held edit.
   */
  write(
    def: ConfigFileDef<any> | ConfigCollectionDef<any>,
    name: string | undefined,
    edit: ConfigEdit,
    options?: { readonly ifMatch?: string },
  ): Promise<ConfigWriteOutcome>;
  /**
   * The CALLER's own write of one of this plugin's declared files, for a route whose person authored the edit (an Add
   * form). Judged exactly as {@link write} — the same validation, `ifMatch`, size cap, hold rules, raw-secret refusal
   * and every other check — except for NN2: a `${secret:NAME}` reference the CALLER'S edit adds goes into effect (not
   * held) only when the AMBIENT call, which the kernel carries and a plugin can neither pass nor set, is the owner: the
   * host admin where the request arrived on the host (a relayed loopback is remote), or a governed device that holds the
   * file's configure capability and a passkey that already existed when the call was admitted, claimed once — what
   * `PUT /v1/config/file` asks of an add (`loosen-config`); the unlock alone is not enough, and a passkey proved
   * AFTER the call was admitted is never taken by the call or by work it spawns. A ferret's session credential, a job, a member call and a caller
   * outside a call keep the hold exactly as {@link write} holds it; no option can switch it off for an agent. The act is
   * logged with the file and the secret NAME, never a value, and the kernel never reads a value to judge it.
   *
   * The owner's answer covers ONLY the references the caller's own edit introduces relative to the text it edits. A
   * reference that only an edit already held names keeps the WHOLE write held, whoever asks, and the log credits the
   * owner for its own references alone. A PATCH of a file with an edit held for the owner is made to BOTH versions, as
   * {@link writeAsOwner} makes one (the version in effect, patched and judged as the caller's own act; the held version,
   * patched, stays held and is answered as `stillHeld`), so a patch of one field never puts the held edit into effect;
   * a WHOLE text is the caller's whole text, and replaces the held edit. The question
   * is SYNCHRONOUS (nothing can time out; a missing judge, a throw or no answer holds) and is asked of the standing as
   * it is WHEN THE WRITE HAPPENS, not as it was when the call was admitted: the ambient scope also covers work the call
   * spawns (a timer, a listener) long after it ended, so a device revoked, locked or narrowed since holds. A route that
   * declares no capability and does not consult the grants (`consultsGrants`) gives the call no grant standing, so it
   * holds every caller's add, the host admin's too.
   */
  writeAsCaller(
    def: ConfigFileDef<any> | ConfigCollectionDef<any>,
    name: string | undefined,
    edit: ConfigEdit,
    options?: { readonly ifMatch?: string },
  ): Promise<ConfigWriteOutcome>;
  /**
   * The OWNER's own patch of one of its own files (today's rule 3, docs/config-files.md: "a save never discards a
   * held edit"). A patch only — top-level keys, `undefined` removes one — because the owner's act is the keys they
   * changed, never a whole text rendered from what is in effect.
   *
   * With no edit held it is {@link write} of that patch. With an edit of the same file held for the owner, the patch
   * is made to BOTH versions: the version in effect, patched, is recorded as accepted — at once when the patch itself
   * tightens or Gate's judge lets it loosen — and the held version (the file on disk), patched, stays in the file and
   * stays held, judged against the new record. The judge is asked about the owner's patch ONLY (the sentences of
   * what it changes in the version in effect), never about the held edit that rode along: a save can neither discard
   * a held edit nor put one into effect that nobody confirmed. When the judge holds the patch itself, the version in
   * effect is untouched and the patch waits with the held version.
   *
   * `within` (optional) names TOP-LEVEL keys whose mapping the patch MERGES into instead of replacing, in both
   * versions, each into its own mapping — ONE level deep: each sub-key the patch names is replaced whole (`undefined`
   * removes it), and every sub-key it does not name is kept, so a section saved beside a held edit never puts the held
   * version's other sub-keys back to what is in effect (the 2026-10-29 price incident). A named key whose new or
   * current value is not a mapping is replaced as a plain patch replaces it; a key not named is replaced as before.
   * A merge extends the mapping the file itself holds, so a section the file lacks gets no schema defaults written
   * into it. A `within` that is not a list is refused (`schema`), never guessed at. Without `within` the patch is
   * exactly what it was. The schema, the loosening judgement and Gate's judge run on the MERGED versions; the conflict
   * check is made, on the disk's etag, before either version is patched. Both are written or neither, as for any patch.
   */
  writeAsOwner(
    def: ConfigFileDef<any> | ConfigCollectionDef<any>,
    name: string | undefined,
    edit: { readonly patch: Readonly<Record<string, unknown>>; readonly within?: readonly string[] },
    options?: { readonly ifMatch?: string },
  ): Promise<ConfigWriteOutcome>;
  /**
   * Removes one of its own files; removing what loosens (a budget, a rule) is judged and held like a write.
   * `refuseIfHeld`: a removal that would be held is refused `would_hold` instead, with the file left untouched and
   * nothing held. It is the same one judgement as the removal (asked once, in the same act), never a separate dry run.
   */
  remove(
    def: ConfigFileDef<any> | ConfigCollectionDef<any>,
    name: string | undefined,
    options?: { readonly ifMatch?: string; readonly refuseIfHeld?: true },
  ): Promise<ConfigWriteOutcome>;
  /**
   * Writes SEVERAL of its own declared files as ONE act: every document lands, or none does (a change that spans a
   * runtime, its profile and its model set, which must never be half in effect). Each document is checked exactly as
   * {@link write} checks one — its own def (`not_declared`), its name (`bad_name`), YAML, a raw secret, the schema, its
   * own `ifMatch` — and judged for loosening exactly as {@link write} and {@link writeAsOwner} are: against the version
   * in effect, by the same Gate judge with the call's actor, and an added `${secret:NAME}` is held for the owner
   * whatever the judge says. Every document is checked and judged BEFORE anything is written, so:
   *
   * - one document refused refuses the set (`refused`, naming that document), nothing written;
   * - one document stale (its `ifMatch`, or the disk moved since the last reload) is a `conflict` naming it, nothing
   *   written;
   * - one document the judge would HOLD holds the WHOLE set (`held`): nothing in the set is written or takes effect,
   *   and the outcome names every document that would be held, what each loosens, and says that the set is held.
   *   Nothing is left on disk for the owner to confirm: the caller has the owner make the change in an act Gate's judge
   *   lets through (a step-up), and it is then written whole.
   *
   * A document whose file has ANOTHER edit already held for the owner refuses the set (`already_held`): a set never
   * discards a held edit and never carries one into effect. A document whose file cannot be read (a link, over the
   * size cap) refuses it (`unreadable`), because the set could not put it back. The same file named twice refuses it
   * (`duplicate`). An empty set is `written` with no documents.
   *
   * CRASH: before the first file is touched the kernel records the set's intent (each file's text and accepted record
   * as they were) in its own state; the record is removed only once every file and every accepted record is written,
   * and that removal is the commit. A daemon that stops anywhere before it — between two files included — puts every
   * file of the set and its accepted record back as they were on its next load (boot loads first), so the last good
   * version of every document is what is in effect, and none of the set is. A failure that does not stop the daemon
   * (a disk error) puts them back at once and throws.
   */
  writeAll(documents: readonly ConfigWriteAllDocument[]): Promise<ConfigWriteAllOutcome>;
}

/** One document of a {@link ConfigPort.writeAll}: which of its own files, the edit (or its removal), the etag read. */
export interface ConfigWriteAllDocument {
  readonly def: ConfigFileDef<any> | ConfigCollectionDef<any>;
  /** The collection item; `undefined` for a file. */
  readonly name?: string;
  /** A whole new YAML text, a patch of top-level keys, or the file's removal (judged like {@link ConfigPort.remove}). */
  readonly edit: ConfigEdit | { readonly remove: true };
  /** The etag the caller read this document at (`'absent'` for "nothing there"). */
  readonly ifMatch?: string;
}

/** Where one document of a set is: its file under `config/` and, for a collection item, its name. Never a value. */
export interface ConfigDocumentRef {
  readonly path: string;
  readonly name?: string;
}

/**
 * What a {@link ConfigPort.writeAll} did, never thrown (only a disk failure the set was put back from throws):
 * `written` (every document is in effect), `held` (one or more would be held, so NONE was written: `sentence` says so
 * in words), `conflict` (that document moved since it was read), `refused` (that document, or the set, does not check).
 */
export type ConfigWriteAllOutcome =
  | {
      readonly kind: 'written';
      readonly documents: readonly (ConfigDocumentRef & {
        readonly etag: string;
        readonly removed: boolean;
        /** What this document loosened, when the judge let it into effect. */
        readonly loosened: readonly string[];
      })[];
    }
  | {
      readonly kind: 'held';
      /** Every document that would be held, and what each would loosen. */
      readonly held: readonly (ConfigDocumentRef & { readonly sentences: readonly string[] })[];
      /** The plain sentence: which document(s) loosen, that the set is held and that nothing in it was written. */
      readonly sentence: string;
    }
  | ({ readonly kind: 'conflict' } & ConfigDocumentRef)
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'yaml'
        | 'raw_secret'
        | 'schema'
        | 'not_declared'
        | 'bad_name'
        | 'not_a_mapping'
        | 'duplicate'
        | 'already_held'
        | 'unreadable';
      /** The document refused; absent only when the document named no def this plugin declared. */
      readonly document?: ConfigDocumentRef;
      readonly issues: readonly ConfigWriteIssue[];
    };

/** One declared config file or collection item, named for the writer. */
export interface ConfigTarget {
  readonly plugin: string;
  readonly def: ConfigFileDef<any> | ConfigCollectionDef<any>;
  readonly name?: string;
}

/** One located problem with a config file, as an editor shows it: where, what, and the plain fix. Never a value. */
export interface ConfigFileIssue {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly fix: string;
}

/** A config file as it is on disk, for an editor: its text, etag and state. */
export interface ConfigFileRead {
  readonly path: string;
  readonly exists: boolean;
  readonly text: string | undefined;
  readonly etag: string;
  readonly status: ConfigFileStatus;
  /** What is wrong with the file, located (an invalid or unreadable file). Absent: none to show. */
  readonly issues?: readonly ConfigFileIssue[];
  /**
   * The version IN EFFECT as its text spells it out, before any default fills a gap: what an owner actually wrote, read
   * by the kernel's own bounded reader (the size cap, the alias budget, no YAML 1.1 tags). Absent when nothing is in
   * effect. A reader that needs to know what was written uses this, never a parse of `text` of its own: `text` is the
   * disk's, and a hand-written file there may be one that the kernel refused because reading it would never end.
   */
  readonly written?: unknown;
}

/** An edit held for the owner (the tighter version stays in effect until it is confirmed or discarded). */
export interface HeldConfig {
  readonly id: string;
  readonly plugin: string;
  readonly path: string;
  readonly name?: string;
  readonly etag: string;
  readonly removal: boolean;
  readonly sentences: readonly string[];
}

/**
 * The writer over EVERY declared config file, given to Gate alone (`kernel.configFiles`; `undefined` for every other
 * plugin). Gate's config route decides who may write and whether this act may confirm a loosening
 * (`confirmedLoosening`, after its step-up); the mechanism — atomic write, `ifMatch` conflict, last good, held
 * loosening, comment-keeping patches, raw-secret refusal — is the kernel's (today's `ConfigFilesService`).
 */
export interface ConfigFilesWriter {
  declarations(): readonly { readonly plugin: string; readonly def: ConfigFileDef<any> | ConfigCollectionDef<any> }[];
  read(target: ConfigTarget): Promise<ConfigFileRead | undefined>;
  write(
    target: ConfigTarget,
    edit: ConfigEdit,
    options?: {
      readonly confirmedLoosening?: boolean;
      readonly ifMatch?: string;
      /** Asked only when the edit loosens and `confirmedLoosening` is not set: true puts it into effect (Gate's claim). */
      readonly judge?: (sentences: readonly string[], removal: boolean) => boolean;
      /**
       * An agent's own write: as untrusted as a plugin's, so an edit that adds a `${secret:NAME}` reference is held for
       * the owner and neither `confirmedLoosening` nor a judge confirms it (NN2).
       */
      readonly byAgent?: true;
    },
  ): Promise<ConfigWriteOutcome>;
  remove(
    target: ConfigTarget,
    options?: { readonly confirmedLoosening?: boolean; readonly ifMatch?: string },
  ): Promise<ConfigWriteOutcome>;
  held(): readonly HeldConfig[];
  /**
   * Confirms ONE held edit by id; `false` when there is no such edit any more. The id carries the FULL etag of the
   * edit that was reviewed and is matched against the disk inside the write queue, after a fresh reload: a file that
   * moved since is never confirmed.
   */
  confirm(id: string): Promise<boolean>;
  /** Drops ONE held edit: the file goes back to the version in effect. Matched like {@link ConfigFilesWriter.confirm}. */
  discard(id: string): Promise<boolean>;
}
