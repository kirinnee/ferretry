/**
 * The daemon's config files (§7.2): every plugin's declared `defineConfig` files and collections, read, watched, put
 * into effect file by file with the last good version winning, and written by every editor through one door. Today's
 * `ConfigFilesService` with the per-file knowledge taken out: the schema and the `loosens` judgement are the
 * plugin's, the mechanism is the kernel's.
 *
 * ## One evaluation, many readers
 *
 * A reload scans every declared path and evaluates each file (`./evaluate.ts`). Readers take the answer of the LAST
 * reload, synchronously, from their {@link ConfigPort}; what moves the configuration is a short list, and each of
 * them reloads: the watcher on a change it sees, this service's own writes and confirmations, and boot. A reload
 * that finds a file different from the last reload tells the listeners of that file's def; the first reload is the
 * baseline, not a change.
 *
 * ## The accepted record
 *
 * What is in effect is remembered in `state/kernel/accepted-config/`, file by file, with its text, so the last good
 * version of a file survives a restart and a loosening confirmed once is not asked about again. A record belongs to
 * the plugin it was accepted for (its id is stored with it): another plugin that claims the path does not inherit it,
 * and a record that names no plugin is accepted for nobody.
 *
 * ## Writing
 *
 * A write is checked first and refused whole if it does not check: bad YAML, a raw secret, a schema failure, a
 * def the plugin did not declare. A loosening is put into effect only when the caller confirms it in the same act
 * (`confirmedLoosening`, decided by Gate, never by the plugin); otherwise the file is written and the edit is HELD,
 * the tighter version in effect. A patch edits only the changed keys, so comments survive.
 *
 * Every load and every write runs one at a time, so two of them can never each decide against a record the other is
 * about to replace.
 */
import { addedSecretReferenceSentences, secretReferencesIn } from '../secrets.ts';
import { createHash } from 'node:crypto';
import { type Duration, milliseconds } from '@ferretry/std';
import type {
  Cancel,
  Clock,
  ConfigCollectionDef,
  ConfigFileDef,
  ConfigFileStatus,
  ConfigFilesWriter,
  ConfigPort,
  ConfigStateChange,
  ConfigWriteAllDocument,
  ConfigWriteAllOutcome,
  ConfigWriteIssue,
  ConfigWriteOutcome,
  Log,
  StatePort,
} from '../../contract/index.ts';
import { judgeLoosening } from '../../contract/define.ts';
import { StoreDamagedError } from '../state/errors.ts';
import type { HostFs } from '../state/host-fs.ts';
import { createStatePort } from '../state/state-port.ts';
import { acceptedConfigFile, acceptedName, pathOfAcceptedName } from './accepted.ts';
import {
  type AnyConfigDef as ConfigDef,
  assertNoSharedPaths,
  CONFIG_EXTENSION,
  type ConfigDeclaration,
  claimOf,
  SCHEMA_FOLDER,
} from './claims.ts';
import { checkConfigText, type ConfigIssue, type ConfigRefusal } from './check.ts';
import { type ConfigCheckMemo, createConfigCheckMemo } from './check-memo.ts';
import {
  type AcceptedConfig,
  ABSENT_CONFIG_ETAG,
  type ConfigEntryState,
  type DiskState,
  type EvaluatedConfig,
  defaultsOf,
  evaluateConfig,
} from './evaluate.ts';
import { configJsonSchemaText, schemaFileName, schemaModeline } from './schemas.ts';
import { type ConfigTreeEvents, watchConfigFiles } from './watcher.ts';
import { readConfigDisk } from './disk.ts';
import { CONFIG_FILE_MAX_BYTES, editConfigText, readConfigTextToEdit } from './yaml-text.ts';
import { isWithinList, patchedValue } from './patch.ts';
import {
  ALREADY_HELD_ISSUE,
  type DocumentVerdict,
  DUPLICATE_ISSUE,
  firstStop,
  heldSet,
  judgeSet,
  refusedDocument,
  repeatedDocument,
  UNREADABLE_ISSUE,
} from './write-all.ts';
import { configWriteSetFile, type WriteSetJournal } from './write-set-journal.ts';
import { type ConfigFileMove, configFileMoves, type StampedConfigFile } from './state-change.ts';

/** The most a configuration file may hold; a larger one is not read, and keeps its last good version. */
export { CONFIG_FILE_MAX_BYTES };

/** How long an acknowledged write may take to land before the acknowledgement lapses. */
export const ACKNOWLEDGEMENT_TTL_MS = 10 * 60_000;

const PRIVATE_FILE_MODE = 0o600;

// ─── What callers see ─────────────────────────────────────────────────────────────────────────────────────────────

/** An edit held for the owner. The tighter version stays in effect until it is confirmed or discarded. */
export interface HeldConfigEdit {
  /** `<path>@<full etag>`: names ONE reviewed edit; confirm and discard compare it inside the write queue, so an edit nobody saw (even one whose etag shares a prefix) is never put into effect or dropped. */
  readonly id: string;
  readonly plugin: string;
  /** The file, relative to `config/`. */
  readonly path: string;
  readonly name?: string;
  readonly etag: string;
  /** Whether the held edit is the file's removal. */
  readonly removal: boolean;
  /** Plain sentences naming what widened. */
  readonly sentences: readonly string[];
}

/** A whole new text, or a patch of top-level keys (an `undefined` value removes the key). */
export type ConfigEdit = string | { readonly patch: Readonly<Record<string, unknown>> };

export interface ConfigWriteOptions {
  /** Whether the caller may put a loosening into effect in this same act (Gate proved it). Default: no. */
  readonly confirmedLoosening?: boolean;
  /** Asked only when the edit loosens and `confirmedLoosening` is not set: Gate's judge for a plugin's own write. */
  readonly judge?: (sentences: readonly string[], removal: boolean) => boolean;
  /** The etag the editor read; a file that moved since is refused `conflict`. */
  readonly ifMatch?: string;
  /**
   * The plugin's OWN write (`kernel.config.write`): an edit that adds a `${secret:NAME}` reference is held for the
   * owner, and neither Gate's judge nor anything else confirms it (NN2). The owner's writer never sets it.
   */
  readonly byPlugin?: true;
  /**
   * An AGENT's write (`config_write`): as untrusted as a plugin's own, so an edit that adds a `${secret:NAME}` reference
   * is held for the owner and nothing confirms it (NN2). The owner's writer never sets it.
   */
  readonly byAgent?: true;
  /** A removal only: one that would be held is refused `would_hold`, with the file untouched and nothing held. */
  readonly refuseIfHeld?: true;
}

/** A write whose `${secret:NAME}` additions only the owner may make: a plugin's own, or an agent's. */
const untrustedWrite = (writeOptions: Pick<ConfigWriteOptions, 'byPlugin' | 'byAgent'>): boolean =>
  writeOptions.byPlugin === true || writeOptions.byAgent === true;

type Checked = ReturnType<typeof checkConfigText>;

export type ConfigWriteRefusal = ConfigRefusal | 'not_declared' | 'bad_name' | 'conflict' | 'not_a_mapping';

export type ConfigWriteResult =
  | {
      readonly kind: 'applied';
      readonly etag: string;
      readonly text: string;
      /** What the write loosened, when the caller confirmed it. */
      readonly loosened: readonly string[];
      /** An owner write that left another edit of the file held: its id and what it widens. */
      readonly stillHeld?: { readonly id: string; readonly sentences: readonly string[] };
    }
  | { readonly kind: 'held'; readonly etag: string; readonly id: string; readonly sentences: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: ConfigWriteRefusal; readonly issues: readonly ConfigIssue[] };

export type ConfigRemoveResult =
  | { readonly kind: 'applied'; readonly loosened: readonly string[] }
  | { readonly kind: 'held'; readonly id: string; readonly sentences: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: 'not_declared' | 'bad_name' | 'conflict' }
  | { readonly kind: 'refused'; readonly reason: 'would_hold'; readonly sentences: readonly string[] };

export interface ConfigFileView {
  readonly path: string;
  readonly exists: boolean;
  readonly text: string | undefined;
  readonly etag: string;
  readonly state: ConfigEntryState;
  readonly issues: readonly ConfigIssue[];
}

export interface ConfigStatus {
  readonly files: readonly { readonly path: string; readonly plugin: string; readonly state: ConfigEntryState }[];
  readonly issues: readonly ConfigIssue[];
  readonly held: readonly HeldConfigEdit[];
}

export interface ConfigFilesOptions {
  /** The home, absolute; config is `<home>/config`. */
  readonly home: string;
  readonly defs: readonly ConfigDeclaration[];
  readonly fs: HostFs;
  readonly clock: Pick<Clock, 'nowMs' | 'after' | 'every'>;
  readonly log: Log;
  /** The binary's name, for the sentences that name a command. */
  readonly binary: string;
  /** The kernel's state port, which must declare {@link acceptedConfigFile}; absent, one is made over `fs`. */
  readonly state?: StatePort;
  /** Where the checks the loads make are kept; absent, a fresh one. A test hands one in to see what is kept. */
  readonly checks?: ConfigCheckMemo;
  /**
   * Gate's judge of a plugin's OWN loosening write (`Admission.judgeConfigWrite`, read live, with the call's actor):
   * true puts it into effect. Absent or throwing: held for the owner.
   */
  readonly judge?: (input: {
    readonly plugin: string;
    readonly path: string;
    readonly removal: boolean;
    readonly sentences: readonly string[];
  }) => boolean;
}

export interface ConfigFiles {
  /** The `ConfigPort` of one plugin: only its own declared defs, answering the last reload. */
  port(pluginId: string): ConfigPort;
  write(
    plugin: string,
    def: ConfigDef,
    name: string | undefined,
    edit: ConfigEdit,
    options?: ConfigWriteOptions,
  ): Promise<ConfigWriteResult>;
  /**
   * The owner's own patch, made to BOTH the version in effect and an edit held for the owner (`ConfigPort.writeAsOwner`);
   * a top-level key named in `within` merges into its mapping one level deep (`./patch.ts`).
   */
  writeAsOwner(
    plugin: string,
    def: ConfigDef,
    name: string | undefined,
    edit: { readonly patch: Readonly<Record<string, unknown>>; readonly within?: readonly string[] },
    options?: ConfigWriteOptions,
  ): Promise<ConfigWriteResult>;
  /** Removes a file. Removing what loosens (a budget, a rule) is held like any loosening edit. */
  remove(
    plugin: string,
    def: ConfigDef,
    name: string | undefined,
    options?: ConfigWriteOptions,
  ): Promise<ConfigRemoveResult>;
  /**
   * Several of one plugin's files as ONE act (`ConfigPort.writeAll`): all checked and judged first, then written
   * under an intent record ({@link configWriteSetFile}) whose removal is the commit. `judge` is asked per document with
   * its path, as `write` asks its own; `ifMatch` is each document's own.
   */
  writeAll(
    plugin: string,
    documents: readonly ConfigWriteAllDocument[],
    options?: Omit<ConfigWriteOptions, 'judge' | 'ifMatch' | 'refuseIfHeld'> & {
      readonly judge?: (path: string, sentences: readonly string[], removal: boolean) => boolean;
    },
  ): Promise<ConfigWriteAllOutcome>;
  /** One file as it is on disk, with its etag and state; absent, the schema's modeline is not invented. */
  read(plugin: string, def: ConfigDef, name?: string): Promise<ConfigFileView | undefined>;
  held(): readonly HeldConfigEdit[];
  /** Confirms ONE held edit by id; `false` when there is no such edit any more. */
  confirm(id: string): Promise<boolean>;
  /** Drops ONE held edit: the file goes back to the version in effect. Only ever tightens. */
  discard(id: string): Promise<boolean>;
  /** Scan, evaluate, remember. Boot calls it once before any plugin reads; the watcher calls it on a change. */
  reload(): Promise<void>;
  /**
   * Told every file of EVERY plugin that moved on disk or in state at a reload (`./state-change.ts`), with its plugin:
   * what the host publishes as `kernel.config-changed`. The first load is the baseline. Answers the cancel.
   */
  onStateChange(listener: (plugin: string, move: ConfigFileMove) => void): Cancel;
  status(): ConfigStatus;
  /** Watch the tree and reload when it changes (debounced). Answers the stop. */
  startWatching(events?: ConfigTreeEvents): () => void;
  /** Every folder of the tree as of now, root included: what a platform file-event hub watches (`ConfigTreeEvents`). */
  directories(): Promise<readonly string[]>;
  /** Writes every def's JSON Schema into `config/.schema/`, each only when it changed. */
  publishSchemas(): Promise<void>;
  /** The writer over every declared file, as Gate receives it (`kernel.configFiles`). */
  writer(): ConfigFilesWriter;
  /**
   * Every `${secret:NAME}` the plugin's OWN files name, as they are IN EFFECT (an edit held for the owner names
   * nothing yet): what `kernel.secrets` checks a name against.
   */
  secretReferences(plugin: string): ReadonlySet<string>;
  /**
   * The same references, counted only in the plugin's defs that are marked `credentialRecords`: the owner-written
   * secrets of its credential records, which a provider acting for it (the Vault) may count as its own.
   */
  credentialRecordReferences(plugin: string): ReadonlySet<string>;
}

/** Located issues as the contract says them: where, what and the fix, never a value. */
const writeIssues = (issues: readonly ConfigIssue[]): ConfigWriteIssue[] =>
  issues.map(issue => ({
    path: issue.path,
    ...(issue.line === undefined ? {} : { line: issue.line }),
    ...(issue.column === undefined ? {} : { column: issue.column }),
    message: issue.message,
    fix: issue.fix,
  }));

/** A write result as the contract says it: never thrown, `conflict` on its own. */
function writeOutcome(result: ConfigWriteResult): ConfigWriteOutcome {
  if (result.kind === 'applied')
    return {
      kind: 'written',
      etag: result.etag,
      loosened: result.loosened,
      ...(result.stillHeld === undefined ? {} : { stillHeld: result.stillHeld }),
    };
  if (result.kind === 'held') return { kind: 'held', etag: result.etag, id: result.id, sentences: result.sentences };
  if (result.reason === 'conflict') return { kind: 'conflict' };
  return { kind: 'refused', reason: result.reason, issues: writeIssues(result.issues) };
}

/** An entry's state as the contract names it. */
function statusOf(evaluated: EvaluatedConfig | undefined): ConfigFileStatus {
  if (evaluated === undefined) return { state: 'absent', inEffect: false, sentences: [] };
  const inEffect = evaluated.inEffect !== undefined;
  switch (evaluated.state) {
    case 'ok':
      return { state: 'valid', inEffect, sentences: [] };
    case 'pending':
      return { state: 'held', inEffect, sentences: evaluated.held?.sentences ?? [] };
    case 'invalid':
      return { state: 'invalid', inEffect, sentences: evaluated.issues.map(issue => issue.message) };
    default:
      return { state: 'absent', inEffect, sentences: [] };
  }
}

// ─── Internals ────────────────────────────────────────────────────────────────────────────────────────────────────

interface Slot {
  readonly declaration: ConfigDeclaration;
  readonly path: string;
  readonly name: string | undefined;
}

interface Settled {
  readonly slot: Slot;
  readonly evaluated: EvaluatedConfig;
  readonly diskText: string | undefined;
  readonly diskEtag: string;
}

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const idOf = (path: string, etag: string): string => `${path}@${etag}`;

const issueKey = (issue: ConfigIssue): string =>
  `${issue.path}\u0000${String(issue.line)}\u0000${String(issue.column)}\u0000${issue.message}`;

const duration = (ms: number): Duration => milliseconds(ms);

export function createConfigFiles(options: ConfigFilesOptions): ConfigFiles {
  const { home, fs, log, binary } = options;
  assertNoSharedPaths(options.defs);
  const root = `${home}/config`;
  const state: StatePort =
    options.state ?? createStatePort({ home, pluginId: 'kernel', files: [acceptedConfigFile], fs });
  const declarations = [...options.defs];
  /** The write-set intent record's own port (the kernel's state folder): only this service reads or writes it. */
  const journalState: StatePort = createStatePort({ home, pluginId: 'kernel', files: [configWriteSetFile], fs });
  /** Said once per damaged record, not on every load. */
  let journalDamageSaid = false;

  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  let settled = new Map<string, Settled>();
  let loaded = false;
  let reported = new Set<string>();
  let issues: readonly ConfigIssue[] = [];
  const listeners = new Map<ConfigDef, Set<() => void>>();
  /** `ConfigPort.watchState`'s listeners, by def: a file of that def moved on disk or in state. */
  const stateListeners = new Map<ConfigDef, Set<(change: ConfigStateChange) => void>>();
  /** The host's feed of every move, for the `kernel.config-changed` bus event. */
  const moveListeners = new Set<(plugin: string, move: ConfigFileMove) => void>();
  /** Texts about to be written on the owner's behalf: consumed by the first load that finds exactly those bytes. */
  const acknowledged = new Map<string, { readonly etag: string; readonly text: string; readonly at: number }>();
  const acknowledgedRemovals = new Map<string, number>();

  /**
   * The checks the last load made ({@link ConfigCheckMemo}). The check is pure in the definition, the path and the
   * text, and every load evaluates every file — its accepted text and its disk text, which are most often the same —
   * so without this one read, write or reload of any file parsed every declared file twice: seconds once a few of them
   * are near the size cap. Only a load keeps a check, and only for a file it settled: a write that is refused leaves
   * nothing here (an agent writing a refused text under a new name each call once grew this without end).
   */
  const checks: ConfigCheckMemo = options.checks ?? createConfigCheckMemo();
  /**
   * The checks of the texts the write in progress is about to put on disk, handed to the load that follows it so that
   * load does not parse them again. Only texts that passed their check, at most two (the owner's patch of a held file
   * writes the version in effect and the held one), and emptied by that load whatever happens.
   */
  let landing: readonly { readonly path: string; readonly digest: string; readonly checked: Checked }[] = [];
  /** A check outside a load: one the last load kept answers, and nothing new is kept. */
  const check = (def: ConfigDef, path: string, text: string): Checked =>
    checks.get(path, digest(text)) ?? checkConfigText(def, path, text, binary);
  /** A check inside a load: kept, since this load settles the file. */
  const checkInLoad = (def: ConfigDef, path: string, text: string): Checked => {
    const key = digest(text);
    const checked =
      checks.get(path, key) ??
      landing.find(item => item.path === path && item.digest === key)?.checked ??
      checkConfigText(def, path, text, binary);
    checks.keep(path, key, checked);
    return checked;
  };

  // ── slots ────────────────────────────────────────────────────────────────────────────────────────────────────────

  const declared = (plugin: string, def: ConfigDef): ConfigDeclaration | undefined =>
    declarations.find(item => item.plugin === plugin && item.def === def);

  const slotFor = (declaration: ConfigDeclaration, name: string | undefined): Slot | undefined => {
    const { def } = declaration;
    if (def.shape === 'file') return name === undefined ? { declaration, path: def.file, name: undefined } : undefined;
    if (name === undefined || !def.name.test(name)) return undefined;
    return { declaration, path: `${def.collection}/${name}${CONFIG_EXTENSION}`, name };
  };

  /** The stored record for a path, whoever it was accepted for; `undefined` when there is none or it cannot be read. */
  const readStored = async (path: string) => {
    const read = await state.read(acceptedConfigFile, acceptedName(path));
    return read.ok ? read.value : undefined;
  };

  /** What was accepted for THIS plugin at this path: a record of another plugin, or of none, is nothing. */
  const acceptedFor = (plugin: string, stored: Awaited<ReturnType<typeof readStored>>): AcceptedConfig | undefined =>
    stored?.plugin === plugin ? { etag: stored.etag, text: stored.text } : undefined;

  const writeAccepted = async (plugin: string, path: string, accepted: AcceptedConfig | undefined): Promise<void> => {
    const name = acceptedName(path);
    if (accepted === undefined) return await state.remove(acceptedConfigFile, name);
    const record = { etag: accepted.etag, text: accepted.text, plugin };
    try {
      await state.write(acceptedConfigFile, record, name);
    } catch (error) {
      if (!(error instanceof StoreDamagedError)) throw error;
      // The record is the daemon's own; one that cannot be read means nothing accepted, so it is replaced.
      await state.remove(acceptedConfigFile, name);
      await state.write(acceptedConfigFile, record, name);
    }
  };

  const readDisk = async (path: string): Promise<DiskState> => await readConfigDisk(fs, `${root}/${path}`);

  /** Every slot there is: each declared file, each collection item on disk, and each accepted item whose file is gone. */
  const gatherSlots = async (extra: ConfigIssue[]): Promise<readonly Slot[]> => {
    const acceptedPaths = (await state.list(acceptedConfigFile)).map(pathOfAcceptedName);
    const slots: Slot[] = [];
    for (const declaration of declarations) {
      const { def } = declaration;
      if (def.shape === 'file') {
        slots.push({ declaration, path: def.file, name: undefined });
        continue;
      }
      const names = new Set<string>();
      for (const entry of await fs.list(`${root}/${def.collection}`)) {
        if (entry.name.startsWith('.') || entry.directory) continue;
        if (!entry.name.endsWith(CONFIG_EXTENSION)) continue;
        const name = entry.name.slice(0, -CONFIG_EXTENSION.length);
        if (def.name.test(name)) names.add(name);
        else
          extra.push({
            path: `${def.collection}/${entry.name}`,
            severity: 'warning',
            message: `"${name}" is not a name ${declaration.plugin} reads here`,
            fix: 'rename the file, or move it out of the config folder',
          });
      }
      for (const path of acceptedPaths) {
        const rest = path.startsWith(`${def.collection}/`) ? path.slice(def.collection.length + 1) : undefined;
        if (rest?.endsWith(CONFIG_EXTENSION) !== true) continue;
        const name = rest.slice(0, -CONFIG_EXTENSION.length);
        if (!name.includes('/') && def.name.test(name)) names.add(name);
      }
      for (const name of [...names].toSorted())
        slots.push({ declaration, path: `${def.collection}/${name}${CONFIG_EXTENSION}`, name });
    }
    return slots;
  };

  /** A `.yaml` file at the top of `config/` that no plugin declared: said once, never read. */
  const strayFiles = async (): Promise<readonly ConfigIssue[]> => {
    const claimed = new Set(declarations.map(({ def }) => claimOf(def).split('/')[0]));
    const found: ConfigIssue[] = [];
    for (const entry of await fs.list(root)) {
      if (entry.name.startsWith('.') || claimed.has(entry.name) || entry.directory) continue;
      if (entry.name.endsWith(CONFIG_EXTENSION))
        found.push({
          path: entry.name,
          severity: 'warning',
          message: 'no plugin reads this file',
          fix: 'check its name, or move it out of the config folder',
        });
    }
    return found;
  };

  const report = (all: readonly ConfigIssue[], held: readonly HeldConfigEdit[]): void => {
    const seen = new Set<string>();
    for (const issue of all) {
      const key = issueKey(issue);
      seen.add(key);
      if (!reported.has(key))
        log[issue.severity === 'error' ? 'warn' : 'info'](
          `config ${issue.path}${issue.line === undefined ? '' : `:${issue.line}`}: ${issue.message}`,
        );
    }
    for (const edit of held) {
      const key = `held\u0000${edit.id}`;
      seen.add(key);
      if (!reported.has(key))
        log.info(`config ${edit.path}: an edit is held for the owner (${edit.sentences.join('; ')})`);
    }
    reported = seen;
  };

  const heldOf = (all: ReadonlyMap<string, Settled>): readonly HeldConfigEdit[] =>
    [...all.values()].flatMap(({ slot, evaluated }) =>
      evaluated.held === undefined
        ? []
        : [
            {
              id: idOf(slot.path, evaluated.held.etag),
              plugin: slot.declaration.plugin,
              path: slot.path,
              ...(slot.name === undefined ? {} : { name: slot.name }),
              etag: evaluated.held.etag,
              removal: evaluated.held.etag === ABSENT_CONFIG_ETAG,
              sentences: evaluated.held.sentences,
            },
          ],
    );

  // ── load ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  const load = async (): Promise<void> => {
    try {
      await loadAll();
    } finally {
      landing = [];
    }
  };

  /**
   * Puts every file of a write set and its accepted record back as they were before the set (`journal`), then removes
   * the record. Idempotent: run again after a stop part-way through, it writes the same texts and records.
   */
  const rollBack = async (journal: WriteSetJournal): Promise<readonly string[]> => {
    // A file is put back only while it still holds what the set wrote (or already its prior): one the owner changed
    // since is theirs, and is left as it is.
    const kept: string[] = [];
    const putBack: (typeof journal.documents)[number][] = [];
    for (const document of journal.documents) {
      const absolute = `${root}/${document.path}`;
      const current = await fs.readText(absolute).catch(() => undefined);
      const now = current === undefined ? null : digest(current);
      const before = document.prior === null ? null : digest(document.prior);
      if (now !== document.written && now !== before) {
        kept.push(document.path);
        continue;
      }
      putBack.push(document);
      if (document.prior === null) await fs.remove(absolute);
      else await fs.writeAtomic(absolute, document.prior, PRIVATE_FILE_MODE);
    }
    for (const document of putBack) {
      const name = acceptedName(document.path);
      if (document.accepted === null) await state.remove(acceptedConfigFile, name);
      else await state.write(acceptedConfigFile, document.accepted, name);
    }
    await journalState.remove(configWriteSetFile);
    return kept;
  };

  /**
   * A write set the daemon stopped in the middle of (its intent record is still there): put back whole before this
   * load evaluates anything, so the last good version of every one of its files is in effect and none of the set is.
   */
  const recoverWriteSet = async (): Promise<void> => {
    const read = await journalState.read(configWriteSetFile);
    if (!read.ok) {
      if (!journalDamageSaid)
        log.warn(
          `config: an interrupted write set cannot be read, so its files are judged as they are (${read.error.reason})`,
        );
      journalDamageSaid = true;
      return;
    }
    journalDamageSaid = false;
    if (read.value === undefined) return;
    const kept = await rollBack(read.value);
    log.warn(
      `config: a write set of ${read.value.documents.length} file(s) for ${read.value.plugin} did not finish; ${String(read.value.documents.length - kept.length)} of them were put back as they were` +
        (kept.length === 0 ? '' : `, and ${String(kept.length)} changed since were left as they are`),
    );
  };

  const loadAll = async (): Promise<void> => {
    await recoverWriteSet();
    const extra: ConfigIssue[] = [];
    const slots = await gatherSlots(extra);
    const now = options.clock.nowMs();
    const next = new Map<string, Settled>();
    for (const slot of slots) {
      const disk = await readDisk(slot.path);
      const plugin = slot.declaration.plugin;
      const stored = await readStored(slot.path);
      const mine = acceptedFor(plugin, stored);
      let accepted = mine;
      const ack = acknowledged.get(slot.path);
      if (ack !== undefined) {
        if (disk.kind === 'text' && digest(disk.text) === ack.etag) {
          accepted = { etag: ack.etag, text: ack.text };
          acknowledged.delete(slot.path);
        } else if (now - ack.at > ACKNOWLEDGEMENT_TTL_MS) acknowledged.delete(slot.path);
      }
      const removalAt = acknowledgedRemovals.get(slot.path);
      if (removalAt !== undefined) {
        if (disk.kind === 'absent') {
          accepted = undefined;
          acknowledgedRemovals.delete(slot.path);
        } else if (now - removalAt > ACKNOWLEDGEMENT_TTL_MS) acknowledgedRemovals.delete(slot.path);
      }
      const evaluated = evaluateConfig({
        def: slot.declaration.def,
        path: slot.path,
        disk,
        accepted,
        digest,
        binary,
        check: text => checkInLoad(slot.declaration.def, slot.path, text),
      });
      // Compared with this plugin's own record, so another plugin's record is never removed by a load that accepts nothing.
      if (JSON.stringify(evaluated.accepted) !== JSON.stringify(mine))
        await writeAccepted(plugin, slot.path, evaluated.accepted);
      const diskText = disk.kind === 'text' ? disk.text : undefined;
      next.set(slot.path, {
        slot,
        evaluated,
        diskText,
        diskEtag: diskText === undefined ? ABSENT_CONFIG_ETAG : digest(diskText),
      });
    }
    const previous = settled;
    const wasLoaded = loaded;
    settled = next;
    loaded = true;
    // Only the files that are there keep their checks: one removed (or never written) is forgotten.
    checks.keepOnly(next);
    const held = heldOf(next);
    issues = [...[...next.values()].flatMap(item => item.evaluated.issues), ...extra, ...(await strayFiles())];
    report(issues, held);
    if (wasLoaded) announce(previous, next);
  };

  const announce = (before: ReadonlyMap<string, Settled>, after: ReadonlyMap<string, Settled>): void => {
    const moved = new Set<ConfigDef>();
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const left = before.get(path);
      const right = after.get(path);
      if (left?.evaluated.inEffect?.etag !== right?.evaluated.inEffect?.etag)
        moved.add((right ?? left)?.slot.declaration.def as ConfigDef);
    }
    for (const def of moved) {
      for (const listener of listeners.get(def) ?? []) {
        try {
          listener();
        } catch (error) {
          log.warn(`a config listener failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    announceMoves(before, after);
  };

  /** Where each file stands at a load, for `./state-change.ts`: its state as the contract names it, its disk etag. */
  const stampsOf = (all: ReadonlyMap<string, Settled>): ReadonlyMap<string, StampedConfigFile> =>
    new Map(
      [...all].map(([path, { slot, evaluated, diskEtag }]) => [
        path,
        {
          ...(slot.name === undefined ? {} : { name: slot.name }),
          stamp: { state: statusOf(evaluated).state, etag: diskEtag },
        },
      ]),
    );

  /** `watchState` and the host's feed: every file that moved on disk or in state, told once, after the load. */
  const announceMoves = (before: ReadonlyMap<string, Settled>, after: ReadonlyMap<string, Settled>): void => {
    for (const move of configFileMoves(stampsOf(before), stampsOf(after))) {
      const declaration = (after.get(move.path) ?? before.get(move.path))?.slot.declaration as ConfigDeclaration;
      const told = [
        ...[...(stateListeners.get(declaration.def) ?? [])].map(listener => () => listener(move.change)),
        ...[...moveListeners].map(listener => () => listener(declaration.plugin, move)),
      ];
      for (const tell of told) {
        try {
          tell();
        } catch (error) {
          log.warn(`a config listener failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  };

  // ── reading ──────────────────────────────────────────────────────────────────────────────────────────────────────

  const port = (pluginId: string): ConfigPort => {
    const own = (def: ConfigFileDef<any> | ConfigCollectionDef<any>): void => {
      if (declared(pluginId, def as ConfigDef) === undefined)
        throw new Error(`${pluginId} did not declare that config file`);
    };
    return {
      file<Shape>(def: ConfigFileDef<Shape>): Shape | undefined {
        own(def);
        // The settled value is authority (including secret references), never a plugin's mutable object.
        return structuredClone(settled.get(def.file)?.evaluated.value) as Shape | undefined;
      },
      collection<Shape>(def: ConfigCollectionDef<Shape>): ReadonlyMap<string, Shape> {
        own(def);
        const found = new Map<string, Shape>();
        for (const { slot, evaluated } of settled.values()) {
          if (slot.declaration.def === def && slot.name !== undefined && evaluated.value !== undefined)
            found.set(slot.name, structuredClone(evaluated.value) as Shape);
        }
        return new Map([...found].toSorted(([a], [b]) => a.localeCompare(b)));
      },
      watch(def, listener): Cancel {
        own(def);
        const set = listeners.get(def) ?? new Set<() => void>();
        listeners.set(def, set);
        set.add(listener);
        return () => void set.delete(listener);
      },
      watchState(def, listener): Cancel {
        own(def);
        const set = stateListeners.get(def as ConfigDef) ?? new Set<(change: ConfigStateChange) => void>();
        stateListeners.set(def as ConfigDef, set);
        // Each subscription its own entry, so one listener handed in twice is cancelled one at a time.
        const entry = (change: ConfigStateChange): void => listener(change);
        set.add(entry);
        return () => void set.delete(entry);
      },
      fileState(def, name): ConfigFileStatus {
        own(def);
        const declaration = declared(pluginId, def as ConfigDef) as ConfigDeclaration;
        const slot = slotFor(declaration, name);
        return statusOf(slot === undefined ? undefined : settled.get(slot.path)?.evaluated);
      },
      // The etag only (`read` below carries the text and the issues, which a plugin is never handed). Its own def, an
      // existing slot: the same two refusals every other member makes.
      etag: async (def, name): Promise<string> => {
        own(def);
        const declaration = declared(pluginId, def as ConfigDef) as ConfigDeclaration;
        const slot = slotFor(declaration, name);
        if (slot === undefined) throw new Error(`${pluginId} has no config file of that name`);
        // A full reload per ask is O(every config file), so a caller that asks once per file went quadratic. The disk is
        // read for THIS file only, and when its etag is the one the last load settled it is the answer a reload would
        // give (the same read, the same digest); anything else — a file that moved, one never loaded — takes the reload.
        const disk = await readDisk(slot.path);
        const onDisk = disk.kind === 'text' ? digest(disk.text) : ABSENT_CONFIG_ETAG;
        if (loaded && settled.get(slot.path)?.diskEtag === onDisk) return onDisk;
        return (await read(pluginId, def as ConfigDef, name))?.etag ?? ABSENT_CONFIG_ETAG;
      },
      // A plugin's own write takes the one writer; a loosening goes into effect only on Gate's judge, else it is held.
      write: async (def, name, edit, writeOptions = {}): Promise<ConfigWriteOutcome> =>
        writeOutcome(
          await write(pluginId, def as ConfigDef, name, edit, {
            byPlugin: true,
            judge: ownJudge(pluginId, () => pathOf(pluginId, def as ConfigDef, name)),
            ...(writeOptions.ifMatch === undefined ? {} : { ifMatch: writeOptions.ifMatch }),
          }),
        ),
      writeAsOwner: async (def, name, edit, writeOptions = {}): Promise<ConfigWriteOutcome> =>
        writeOutcome(
          await writeAsOwner(pluginId, def as ConfigDef, name, edit, {
            byPlugin: true,
            judge: ownJudge(pluginId, () => pathOf(pluginId, def as ConfigDef, name)),
            ...(writeOptions.ifMatch === undefined ? {} : { ifMatch: writeOptions.ifMatch }),
          }),
        ),
      remove: async (def, name, writeOptions = {}): Promise<ConfigWriteOutcome> =>
        await removeOutcome(pluginId, def as ConfigDef, name, {
          judge: ownJudge(pluginId, () => pathOf(pluginId, def as ConfigDef, name)),
          ...(writeOptions.ifMatch === undefined ? {} : { ifMatch: writeOptions.ifMatch }),
          ...(writeOptions.refuseIfHeld === true ? { refuseIfHeld: true as const } : {}),
        }),
      // The same judge as a single write, asked per document with that document's own path.
      writeAll: async documents =>
        await writeAll(pluginId, documents, {
          byPlugin: true,
          judge: (path, sentences, removal) => ownJudge(pluginId, () => path)(sentences, removal),
        }),
    };
  };

  const read = async (plugin: string, def: ConfigDef, name?: string): Promise<ConfigFileView | undefined> => {
    const declaration = declared(plugin, def);
    const slot = declaration === undefined ? undefined : slotFor(declaration, name);
    if (slot === undefined) return undefined;
    return await serial(async () => {
      await load();
      const found = settled.get(slot.path);
      return {
        path: slot.path,
        exists: found?.diskText !== undefined,
        text: found?.diskText,
        etag: found?.diskEtag ?? ABSENT_CONFIG_ETAG,
        state: found?.evaluated.state ?? 'absent',
        issues: found?.evaluated.issues ?? [],
      };
    });
  };

  // ── writing ──────────────────────────────────────────────────────────────────────────────────────────────────────

  const acknowledge = (path: string, text: string): void => {
    acknowledged.set(path, { etag: digest(text), text, at: options.clock.nowMs() });
  };

  /**
   * The text a patch makes of the file: only the changed keys are rewritten, so comments and order survive. `within`
   * names the top-level keys whose mapping the patch merges into one level deep (`./patch.ts`); none, for every
   * caller but the owner's `writeAsOwner`.
   */
  const patched = (
    slot: Slot,
    existing: string | undefined,
    patch: Readonly<Record<string, unknown>>,
    within?: readonly string[],
  ): string | undefined => {
    const { def } = slot.declaration;
    // One parse: a file that does not parse is replaced whole, and the edit is told so rather than parsing it again.
    const { read, base } = readConfigTextToEdit(existing ?? '');
    const written = read.ok ? read.read.value : {};
    if (typeof written !== 'object' || written === null || Array.isArray(written)) return undefined;
    const meaning = def.schema.safeParse(written);
    const current = (meaning.success ? meaning.data : written) as Record<string, unknown>;
    const target = patchedValue(current, patch, within, written as Record<string, unknown>);
    return editConfigText(existing === undefined ? undefined : base, target, current, schemaModeline(def, slot.path));
  };

  const askJudge = (writeOptions: ConfigWriteOptions, sentences: readonly string[], removal: boolean): boolean => {
    try {
      return writeOptions.judge?.(sentences, removal) === true;
    } catch {
      return false;
    }
  };

  /** A plugin's own write: Gate's judge, never a confirmation of its own. */
  const ownJudge =
    (plugin: string, path: () => string) =>
    (sentences: readonly string[], removal: boolean): boolean =>
      options.judge?.({ plugin, path: path(), removal, sentences }) === true;

  const conflictOf = (slot: Slot, found: string, ifMatch: string | undefined): ConfigWriteResult | undefined => {
    // The file moved since the editor read it, or since the last reload: nothing the readers (and so the editor) saw
    // describes the disk any more, so an edit made from it is never applied.
    const reloaded = settled.get(slot.path)?.diskEtag ?? ABSENT_CONFIG_ETAG;
    const stale = ifMatch !== undefined && ifMatch !== found;
    if (!stale && (found === reloaded || !loaded)) return undefined;
    return {
      kind: 'refused',
      reason: 'conflict',
      issues: [
        {
          path: slot.path,
          severity: 'error',
          message: `${slot.path} changed since it was read`,
          fix: 'read it again and redo the edit',
        },
      ],
    };
  };

  /**
   * One write, inside the queue. The disk is read fresh and must be the disk the last reload saw. `within` is passed by
   * the owner's `writeAsOwner` only: a plain write's patch replaces whole top-level keys.
   */
  const writeLocked = async (
    slot: Slot,
    def: ConfigDef,
    edit: ConfigEdit,
    writeOptions: ConfigWriteOptions,
    within?: readonly string[],
  ): Promise<ConfigWriteResult> => {
    const absolute = `${root}/${slot.path}`;
    const disk = await readDisk(slot.path);
    const existing = disk.kind === 'text' ? disk.text : undefined;
    const found = existing === undefined ? ABSENT_CONFIG_ETAG : digest(existing);
    const moved = conflictOf(slot, found, writeOptions.ifMatch);
    if (moved !== undefined) return moved;
    const text = typeof edit === 'string' ? edit : patched(slot, existing, edit.patch, within);
    if (text === undefined) return { kind: 'refused', reason: 'not_a_mapping', issues: [] };
    const checked = check(def, slot.path, text);
    if (!checked.ok) return { kind: 'refused', reason: checked.reason, issues: checked.issues };
    const etag = digest(text);
    const before = settled.get(slot.path)?.evaluated.value;
    const unchanged = etag === settled.get(slot.path)?.evaluated.inEffect?.etag;
    const added =
      unchanged || !untrustedWrite(writeOptions) ? [] : addedSecretReferenceSentences(before, checked.value);
    const loosens = unchanged ? [] : [...judgeLoosening(def, before, checked.value), ...added];
    const confirmed =
      added.length === 0 &&
      (writeOptions.confirmedLoosening === true || (loosens.length > 0 && askJudge(writeOptions, loosens, false)));
    if (loosens.length === 0 || confirmed) acknowledge(slot.path, text);
    landing = [{ path: slot.path, digest: etag, checked }];
    await fs.writeAtomic(absolute, text, PRIVATE_FILE_MODE);
    await load();
    const held = settled.get(slot.path)?.evaluated.held;
    return held !== undefined && held.etag === etag
      ? { kind: 'held', etag, id: idOf(slot.path, etag), sentences: held.sentences }
      : { kind: 'applied', etag, text, loosened: confirmed ? loosens : [] };
  };

  const write = async (
    plugin: string,
    def: ConfigDef,
    name: string | undefined,
    edit: ConfigEdit,
    writeOptions: ConfigWriteOptions = {},
  ): Promise<ConfigWriteResult> => {
    const declaration = declared(plugin, def);
    if (declaration === undefined) return { kind: 'refused', reason: 'not_declared', issues: [] };
    const slot = slotFor(declaration, name);
    if (slot === undefined) return { kind: 'refused', reason: 'bad_name', issues: [] };
    return await serial(async () => await writeLocked(slot, def, edit, writeOptions));
  };

  /**
   * The owner's patch, made to both versions of a file with an edit held (docs/config-files.md rule 3). The judge is
   * asked about the sentences of the owner's OWN patch against the version in effect, never about the held edit.
   * `within` merges the named top-level mappings one level deep in BOTH versions, each into its own mapping, so a
   * sub-key only the held version has survives; the schema, the loosening judgement and the judge see the merged texts.
   */
  const writeAsOwner = async (
    plugin: string,
    def: ConfigDef,
    name: string | undefined,
    edit: { readonly patch: Readonly<Record<string, unknown>>; readonly within?: readonly string[] },
    writeOptions: ConfigWriteOptions = {},
  ): Promise<ConfigWriteResult> => {
    const declaration = declared(plugin, def);
    if (declaration === undefined) return { kind: 'refused', reason: 'not_declared', issues: [] };
    const slot = slotFor(declaration, name);
    if (slot === undefined) return { kind: 'refused', reason: 'bad_name', issues: [] };
    // Never guessed at: a `within` that is not a list would otherwise replace a section the caller meant to merge.
    if (!isWithinList(edit.within))
      return {
        kind: 'refused',
        reason: 'schema',
        issues: [
          {
            path: slot.path,
            severity: 'error',
            message: '`within` must be a list of top-level key names',
            fix: 'name the sections to merge as a list',
          },
        ],
      };
    return await serial(async () => {
      const entry = settled.get(slot.path);
      const heldNow = entry?.evaluated.held;
      if (heldNow === undefined || entry === undefined)
        return await writeLocked(slot, def, { patch: edit.patch }, writeOptions, edit.within);
      const absolute = `${root}/${slot.path}`;
      const disk = await readDisk(slot.path);
      const existing = disk.kind === 'text' ? disk.text : undefined;
      const found = existing === undefined ? ABSENT_CONFIG_ETAG : digest(existing);
      const moved = conflictOf(slot, found, writeOptions.ifMatch);
      if (moved !== undefined) return moved;
      const inEffect = entry.evaluated.inEffect;
      // The version in effect, patched: what the owner's act means today.
      const effectiveText = patched(slot, inEffect?.text, edit.patch, edit.within);
      if (effectiveText === undefined) return { kind: 'refused', reason: 'not_a_mapping', issues: [] };
      const effective = check(def, slot.path, effectiveText);
      if (!effective.ok) return { kind: 'refused', reason: effective.reason, issues: effective.issues };
      // The held version (the file on disk), patched. A held REMOVAL has no text to carry the patch.
      const heldText = existing === undefined ? undefined : patched(slot, existing, edit.patch, edit.within);
      if (existing !== undefined && heldText === undefined)
        return { kind: 'refused', reason: 'not_a_mapping', issues: [] };
      const checkedHeld = heldText === undefined ? undefined : check(def, slot.path, heldText);
      if (checkedHeld !== undefined && !checkedHeld.ok)
        return { kind: 'refused', reason: checkedHeld.reason, issues: checkedHeld.issues };
      // Both passed: the load after the write is handed their checks.
      landing = [
        { path: slot.path, digest: digest(effectiveText), checked: effective },
        ...(heldText === undefined || checkedHeld === undefined
          ? []
          : [{ path: slot.path, digest: digest(heldText), checked: checkedHeld }]),
      ];
      const before = entry.evaluated.value;
      const unchanged = digest(effectiveText) === inEffect?.etag;
      const added =
        unchanged || !untrustedWrite(writeOptions) ? [] : addedSecretReferenceSentences(before, effective.value);
      const loosens = unchanged ? [] : [...judgeLoosening(def, before, effective.value), ...added];
      const confirmed =
        added.length === 0 &&
        (writeOptions.confirmedLoosening === true || (loosens.length > 0 && askJudge(writeOptions, loosens, false)));
      if (loosens.length === 0 || confirmed) {
        // In effect at once; the held edit, changed, stays in the file and is judged against the new record.
        await writeAccepted(plugin, slot.path, { etag: digest(effectiveText), text: effectiveText });
        if (heldText !== undefined) await fs.writeAtomic(absolute, heldText, PRIVATE_FILE_MODE);
        await load();
        const still = settled.get(slot.path)?.evaluated.held;
        return {
          kind: 'applied',
          etag: heldText === undefined ? ABSENT_CONFIG_ETAG : digest(heldText),
          text: heldText ?? effectiveText,
          loosened: confirmed ? loosens : [],
          ...(still === undefined
            ? {}
            : { stillHeld: { id: idOf(slot.path, still.etag), sentences: still.sentences } }),
        };
      }
      // The owner's patch itself waits: the version in effect is untouched, and the patch rides with the held edit
      // (a held removal is superseded by the owner's newer act, said by the answer's sentences).
      const waiting = heldText ?? effectiveText;
      const etag = digest(waiting);
      await fs.writeAtomic(absolute, waiting, PRIVATE_FILE_MODE);
      await load();
      const held = settled.get(slot.path)?.evaluated.held;
      return held !== undefined && held.etag === etag
        ? { kind: 'held', etag, id: idOf(slot.path, etag), sentences: held.sentences }
        : { kind: 'applied', etag, text: waiting, loosened: [] };
    });
  };

  const remove = async (
    plugin: string,
    def: ConfigDef,
    name: string | undefined,
    writeOptions: ConfigWriteOptions = {},
  ): Promise<ConfigRemoveResult> => {
    const declaration = declared(plugin, def);
    if (declaration === undefined) return { kind: 'refused', reason: 'not_declared' };
    const slot = slotFor(declaration, name);
    if (slot === undefined) return { kind: 'refused', reason: 'bad_name' };
    return await serial(async () => {
      await load();
      const disk = await readDisk(slot.path);
      const etag = disk.kind === 'text' ? digest(disk.text) : ABSENT_CONFIG_ETAG;
      if (writeOptions.ifMatch !== undefined && writeOptions.ifMatch !== etag)
        return { kind: 'refused', reason: 'conflict' };
      const current = settled.get(slot.path);
      const defaults = defaultsOf(def);
      // A deletion is judged even with no defaults: `after` is then `undefined` (K5).
      const sentences =
        current?.evaluated.inEffect === undefined ? [] : judgeLoosening(def, current.evaluated.value, defaults);
      const confirmed =
        writeOptions.confirmedLoosening === true || (sentences.length > 0 && askJudge(writeOptions, sentences, true));
      // Asked to refuse rather than hold: decided by this one judgement, before the disk is touched.
      if (sentences.length > 0 && !confirmed && writeOptions.refuseIfHeld === true)
        return { kind: 'refused', reason: 'would_hold', sentences };
      if (sentences.length === 0 || confirmed) acknowledgedRemovals.set(slot.path, options.clock.nowMs());
      await fs.remove(`${root}/${slot.path}`);
      await load();
      const held = settled.get(slot.path)?.evaluated.held;
      return held !== undefined && held.etag === ABSENT_CONFIG_ETAG
        ? { kind: 'held', id: idOf(slot.path, held.etag), sentences: held.sentences }
        : { kind: 'applied', loosened: confirmed ? sentences : [] };
    });
  };

  /** The file a def and name write, relative to `config/` (the def's own path when the name does not fit). */
  const pathOf = (plugin: string, def: ConfigDef, name: string | undefined): string => {
    const declaration = declared(plugin, def);
    const slot = declaration === undefined ? undefined : slotFor(declaration, name);
    return slot?.path ?? claimOf(def);
  };

  const removeOutcome = async (
    plugin: string,
    def: ConfigDef,
    name: string | undefined,
    writeOptions: ConfigWriteOptions,
  ): Promise<ConfigWriteOutcome> => {
    const removed = await remove(plugin, def, name, writeOptions);
    if (removed.kind === 'applied') return { kind: 'written', etag: ABSENT_CONFIG_ETAG, loosened: removed.loosened };
    if (removed.kind === 'held')
      return { kind: 'held', etag: ABSENT_CONFIG_ETAG, id: removed.id, sentences: removed.sentences };
    if (removed.reason === 'conflict') return { kind: 'conflict' };
    if (removed.reason === 'would_hold')
      return { kind: 'refused', reason: 'would_hold', issues: [], sentences: removed.sentences };
    return { kind: 'refused', reason: removed.reason, issues: [] };
  };

  /** One document of a set, checked against the disk and judged for loosening, as `writeLocked` checks one write. */
  interface Planned {
    readonly slot: Slot;
    /** The new text, or `undefined` for the file's removal. */
    readonly text: string | undefined;
    readonly checked: Checked | undefined;
    readonly prior: string | undefined;
    readonly stored: Awaited<ReturnType<typeof readStored>>;
  }

  const planDocument = async (
    slot: Slot,
    document: ConfigWriteAllDocument,
    untrusted: boolean,
  ): Promise<{ readonly verdict: DocumentVerdict; readonly planned?: Planned }> => {
    const { def } = slot.declaration;
    const ref = { path: slot.path, ...(slot.name === undefined ? {} : { name: slot.name }) };
    const entry = settled.get(slot.path);
    // A set never discards a held edit, and never carries one into effect: the owner settles it first.
    if (entry?.evaluated.held !== undefined)
      return { verdict: refusedDocument('already_held', ref, [ALREADY_HELD_ISSUE(slot.path)]) };
    const disk = await readDisk(slot.path);
    // What cannot be read could not be put back by a roll-back, so the set does not touch it.
    if (disk.kind === 'unreadable')
      return { verdict: refusedDocument('unreadable', ref, [UNREADABLE_ISSUE(slot.path)]) };
    const prior = disk.kind === 'text' ? disk.text : undefined;
    const found = prior === undefined ? ABSENT_CONFIG_ETAG : digest(prior);
    if (conflictOf(slot, found, document.ifMatch) !== undefined) return { verdict: { kind: 'conflict', ...ref } };
    // The intent record copies the file as it is; a file holding a raw secret is never copied into the kernel's state.
    if (prior !== undefined) {
      const was = check(def, slot.path, prior);
      if (!was.ok && was.reason === 'raw_secret')
        return { verdict: refusedDocument('raw_secret', ref, writeIssues(was.issues)) };
    }
    const stored = await readStored(slot.path);
    const before = entry?.evaluated.value;
    const { edit } = document;
    if (typeof edit === 'object' && 'remove' in edit) {
      // A removal is judged against the defaults, as `remove` judges it (K5).
      const loosens = entry?.evaluated.inEffect === undefined ? [] : judgeLoosening(def, before, defaultsOf(def));
      return {
        verdict: { kind: 'ready', document: ref, removal: true, loosens, added: [] },
        planned: { slot, text: undefined, checked: undefined, prior, stored },
      };
    }
    const text = typeof edit === 'string' ? edit : patched(slot, prior, edit.patch);
    if (text === undefined) return { verdict: refusedDocument('not_a_mapping', ref) };
    const checked = check(def, slot.path, text);
    if (!checked.ok) return { verdict: refusedDocument(checked.reason, ref, writeIssues(checked.issues)) };
    const unchanged = digest(text) === entry?.evaluated.inEffect?.etag;
    const added = unchanged || !untrusted ? [] : addedSecretReferenceSentences(before, checked.value);
    const loosens = unchanged ? [] : [...judgeLoosening(def, before, checked.value), ...added];
    return {
      verdict: { kind: 'ready', document: ref, removal: false, loosens, added },
      planned: { slot, text, checked, prior, stored },
    };
  };

  const writeAll: ConfigFiles['writeAll'] = async (plugin, documents, writeOptions = {}) =>
    await serial(async (): Promise<ConfigWriteAllOutcome> => {
      // Each document's own def and name first: nothing is read for a set that names a file it may not write.
      const slots: Slot[] = [];
      for (const document of documents) {
        const def = document.def as ConfigDef;
        const declaration = declared(plugin, def);
        if (declaration === undefined) return refusedDocument('not_declared', { path: claimOf(def) });
        const slot = slotFor(declaration, document.name);
        if (slot === undefined)
          return refusedDocument('bad_name', {
            path: claimOf(def),
            ...(document.name === undefined ? {} : { name: document.name }),
          });
        slots.push(slot);
      }
      const twice = repeatedDocument(slots);
      if (twice !== undefined) return refusedDocument('duplicate', { path: twice.path }, [DUPLICATE_ISSUE(twice.path)]);
      // Every document checked before ANY is written: the first one refused or stale is the set's answer.
      const plans: { readonly verdict: DocumentVerdict; readonly planned?: Planned }[] = [];
      for (const [index, slot] of slots.entries())
        plans.push(await planDocument(slot, documents[index] as ConfigWriteAllDocument, untrustedWrite(writeOptions)));
      const stop = firstStop(plans.map(plan => plan.verdict));
      if (stop !== undefined) return stop;
      const ready = plans.map(plan => plan.verdict as Extract<DocumentVerdict, { kind: 'ready' }>);
      const judged = judgeSet(
        ready,
        document =>
          writeOptions.confirmedLoosening === true ||
          askJudge(
            {
              judge: (sentences, removal) => writeOptions.judge?.(document.document.path, sentences, removal) === true,
            },
            document.loosens,
            document.removal,
          ),
      );
      if (judged.held.length > 0) return heldSet(judged, documents.length);
      const planned = plans.map(plan => plan.planned as Planned);
      if (planned.length === 0) return { kind: 'written', documents: [] };
      // The intent record: every file and accepted record as they are now. From here until it is removed, a stop puts
      // the whole set back on the next load; its removal below is the commit.
      const journal: WriteSetJournal = {
        plugin,
        documents: planned.map(item => ({
          path: item.slot.path,
          prior: item.prior ?? null,
          accepted: item.stored ?? null,
          written: item.text === undefined ? null : digest(item.text),
        })),
      };
      await journalState.write(configWriteSetFile, journal);
      try {
        landing = planned.flatMap(item =>
          item.text === undefined || item.checked === undefined
            ? []
            : [{ path: item.slot.path, digest: digest(item.text), checked: item.checked }],
        );
        for (const item of planned) {
          const absolute = `${root}/${item.slot.path}`;
          if (item.text === undefined) await fs.remove(absolute);
          else await fs.writeAtomic(absolute, item.text, PRIVATE_FILE_MODE);
        }
        // Each one in effect as written: the set was judged whole, so its records move with its files.
        for (const item of planned)
          await writeAccepted(
            plugin,
            item.slot.path,
            item.text === undefined ? undefined : { etag: digest(item.text), text: item.text },
          );
        await journalState.remove(configWriteSetFile);
      } catch (error) {
        landing = [];
        // Still running: the load puts the set back now (its intent record is there), the one way a crashed set is put
        // back too. A load the failing disk stops leaves the record, and the next load tries again.
        await load().catch(() => undefined);
        throw error;
      }
      await load();
      return {
        kind: 'written',
        documents: planned.map((item, index) => ({
          path: item.slot.path,
          ...(item.slot.name === undefined ? {} : { name: item.slot.name }),
          etag: item.text === undefined ? ABSENT_CONFIG_ETAG : digest(item.text),
          removed: item.text === undefined,
          loosened: judged.loosened[index] ?? [],
        })),
      };
    });

  const confirm = async (id: string): Promise<boolean> =>
    await serial(async () => {
      await load();
      const held = heldOf(settled).find(item => item.id === id);
      if (held === undefined) return false;
      const found = settled.get(held.path);
      await writeAccepted(
        held.plugin,
        held.path,
        found?.diskText === undefined ? undefined : { etag: found.diskEtag, text: found.diskText },
      );
      await load();
      return true;
    });

  const discard = async (id: string): Promise<boolean> =>
    await serial(async () => {
      await load();
      const held = heldOf(settled).find(item => item.id === id);
      if (held === undefined) return false;
      const found = settled.get(held.path);
      const inEffect = found?.evaluated.inEffect;
      const absolute = `${root}/${held.path}`;
      if (inEffect === undefined) await fs.remove(absolute);
      else {
        acknowledge(held.path, inEffect.text);
        await fs.writeAtomic(absolute, inEffect.text, PRIVATE_FILE_MODE);
      }
      await load();
      return true;
    });

  // ── watching and schemas ────────────────────────────────────────────────────────────────────────────────────────

  const fingerprint = async (): Promise<string> => {
    const parts: string[] = [];
    for (const { def } of declarations) {
      const claim = claimOf(def);
      if (def.shape === 'file') {
        const info = await fs.info(`${root}/${claim}`);
        parts.push(`${claim}:${String(info?.size)}:${String(info?.modifiedAtMs)}:${String(info?.inode)}`);
        continue;
      }
      for (const entry of await fs.list(`${root}/${claim}`)) {
        const info = await fs.info(`${root}/${claim}/${entry.name}`);
        parts.push(`${claim}/${entry.name}:${String(info?.size)}:${String(info?.modifiedAtMs)}:${String(info?.inode)}`);
      }
    }
    return parts.toSorted().join('\n');
  };

  const directories = async (): Promise<readonly string[]> => {
    const found = new Set<string>([root]);
    for (const { def } of declarations) {
      const claim = claimOf(def);
      const folder =
        def.shape === 'collection' ? claim : claim.includes('/') ? claim.slice(0, claim.lastIndexOf('/')) : '';
      if (folder !== '') found.add(`${root}/${folder}`);
    }
    return [...found];
  };

  const startWatching = (events?: ConfigTreeEvents): (() => void) =>
    watchConfigFiles({
      fingerprint,
      onChange: async () => await serial(load),
      onError: error =>
        log.warn(`the config watcher failed: ${error instanceof Error ? error.message : String(error)}`),
      timers: {
        setInterval: (callback, ms) => options.clock.every(duration(ms), callback),
        clearInterval: handle => (handle as Cancel)(),
        setTimeout: (callback, ms) => options.clock.after(duration(ms), callback),
        clearTimeout: handle => (handle as Cancel)(),
      },
      ...(events === undefined ? {} : { events }),
    });

  const publishSchemas = async (): Promise<void> => {
    for (const { def } of declarations) {
      const target = `${root}/${SCHEMA_FOLDER}/${schemaFileName(def)}`;
      const text = configJsonSchemaText(def);
      if ((await fs.readText(target).catch(() => undefined)) !== text)
        await fs.writeAtomic(target, text, PRIVATE_FILE_MODE);
    }
  };

  const status = (): ConfigStatus => ({
    files: [...settled.values()].map(({ slot, evaluated }) => ({
      path: slot.path,
      plugin: slot.declaration.plugin,
      state: evaluated.state,
    })),
    issues,
    held: heldOf(settled),
  });

  return {
    port,
    write,
    writeAsOwner,
    remove,
    writeAll,
    read,
    secretReferences: plugin => {
      const named = new Set<string>();
      for (const entry of settled.values())
        if (entry.slot.declaration.plugin === plugin) secretReferencesIn(entry.evaluated.value, named);
      return named;
    },
    credentialRecordReferences: plugin => {
      const named = new Set<string>();
      for (const entry of settled.values())
        if (entry.slot.declaration.plugin === plugin && entry.slot.declaration.def.credentialRecords === true)
          secretReferencesIn(entry.evaluated.value, named);
      return named;
    },
    held: () => heldOf(settled),
    confirm,
    discard,
    reload: async () => await serial(load),
    onStateChange: listener => {
      const entry = (plugin: string, move: ConfigFileMove): void => listener(plugin, move);
      moveListeners.add(entry);
      return () => void moveListeners.delete(entry);
    },
    directories,
    status,
    startWatching,
    publishSchemas,
    writer: (): ConfigFilesWriter => ({
      declarations: () => declarations.map(({ plugin, def }) => ({ plugin, def })),
      read: async target => {
        const view = await read(target.plugin, target.def as ConfigDef, target.name);
        if (view === undefined) return undefined;
        const declaration = declared(target.plugin, target.def as ConfigDef) as ConfigDeclaration;
        const slot = slotFor(declaration, target.name) as Slot;
        const inEffect = settled.get(slot.path)?.evaluated.inEffect;
        // The load the read made has just checked the text in effect, so this is the check it kept, not a parse.
        const checked = inEffect === undefined ? undefined : check(declaration.def, slot.path, inEffect.text);
        return {
          path: view.path,
          exists: view.exists,
          text: view.text,
          etag: view.etag,
          status: statusOf(settled.get(slot.path)?.evaluated),
          ...(view.issues.length === 0 ? {} : { issues: view.issues }),
          ...(checked?.ok === true ? { written: checked.written } : {}),
        };
      },
      write: async (target, edit, writeOptions = {}) =>
        writeOutcome(await write(target.plugin, target.def as ConfigDef, target.name, edit, writeOptions)),
      remove: async (target, writeOptions = {}) =>
        await removeOutcome(target.plugin, target.def as ConfigDef, target.name, writeOptions),
      held: () => heldOf(settled),
      confirm,
      discard,
    }),
  };
}
