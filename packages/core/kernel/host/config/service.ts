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
 * version of a file survives a restart and a loosening confirmed once is not asked about again.
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
import { editConfigText, readConfigText } from './yaml-text.ts';

/** The most a configuration file may hold; a larger one is not read, and keeps its last good version. */
export const CONFIG_FILE_MAX_BYTES = 256 * 1024;

/** How long an acknowledged write may take to land before the acknowledgement lapses. */
export const ACKNOWLEDGEMENT_TTL_MS = 10 * 60_000;

const PRIVATE_FILE_MODE = 0o600;

// ─── What callers see ─────────────────────────────────────────────────────────────────────────────────────────────

/** An edit held for the owner. The tighter version stays in effect until it is confirmed or discarded. */
export interface HeldConfigEdit {
  /** `<path>@<etag prefix>`: names ONE reviewed edit, so a confirmation can never put into effect one nobody saw. */
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
}

export type ConfigWriteRefusal = ConfigRefusal | 'not_declared' | 'bad_name' | 'conflict' | 'not_a_mapping';

export type ConfigWriteResult =
  | {
      readonly kind: 'applied';
      readonly etag: string;
      readonly text: string;
      /** What the write loosened, when the caller confirmed it. */
      readonly loosened: readonly string[];
    }
  | { readonly kind: 'held'; readonly etag: string; readonly id: string; readonly sentences: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: ConfigWriteRefusal; readonly issues: readonly ConfigIssue[] };

export type ConfigRemoveResult =
  | { readonly kind: 'applied'; readonly loosened: readonly string[] }
  | { readonly kind: 'held'; readonly id: string; readonly sentences: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: 'not_declared' | 'bad_name' | 'conflict' };

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
  /** Removes a file. Removing what loosens (a budget, a rule) is held like any loosening edit. */
  remove(
    plugin: string,
    def: ConfigDef,
    name: string | undefined,
    options?: ConfigWriteOptions,
  ): Promise<ConfigRemoveResult>;
  /** One file as it is on disk, with its etag and state; absent, the schema's modeline is not invented. */
  read(plugin: string, def: ConfigDef, name?: string): Promise<ConfigFileView | undefined>;
  held(): readonly HeldConfigEdit[];
  /** Confirms ONE held edit by id; `false` when there is no such edit any more. */
  confirm(id: string): Promise<boolean>;
  /** Drops ONE held edit: the file goes back to the version in effect. Only ever tightens. */
  discard(id: string): Promise<boolean>;
  /** Scan, evaluate, remember. Boot calls it once before any plugin reads; the watcher calls it on a change. */
  reload(): Promise<void>;
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

/** A write result as the contract says it: never thrown, `conflict` on its own. */
export function writeOutcome(result: ConfigWriteResult): ConfigWriteOutcome {
  if (result.kind === 'applied') return { kind: 'written', etag: result.etag, loosened: result.loosened };
  if (result.kind === 'held') return { kind: 'held', etag: result.etag, id: result.id, sentences: result.sentences };
  if (result.reason === 'conflict') return { kind: 'conflict' };
  return {
    kind: 'refused',
    reason: result.reason,
    issues: result.issues.map(issue => ({
      path: issue.path,
      ...(issue.line === undefined ? {} : { line: issue.line }),
      message: issue.message,
    })),
  };
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

const idOf = (path: string, etag: string): string => `${path}@${etag.slice(0, 12)}`;

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
  /** Texts about to be written on the owner's behalf: consumed by the first load that finds exactly those bytes. */
  const acknowledged = new Map<string, { readonly etag: string; readonly text: string; readonly at: number }>();
  const acknowledgedRemovals = new Map<string, number>();

  // ── slots ────────────────────────────────────────────────────────────────────────────────────────────────────────

  const declared = (plugin: string, def: ConfigDef): ConfigDeclaration | undefined =>
    declarations.find(item => item.plugin === plugin && item.def === def);

  const slotFor = (declaration: ConfigDeclaration, name: string | undefined): Slot | undefined => {
    const { def } = declaration;
    if (def.shape === 'file') return name === undefined ? { declaration, path: def.file, name: undefined } : undefined;
    if (name === undefined || !def.name.test(name)) return undefined;
    return { declaration, path: `${def.collection}/${name}${CONFIG_EXTENSION}`, name };
  };

  const readAccepted = async (path: string): Promise<AcceptedConfig | undefined> => {
    const read = await state.read(acceptedConfigFile, acceptedName(path));
    return read.ok ? read.value : undefined;
  };

  const writeAccepted = async (path: string, accepted: AcceptedConfig | undefined): Promise<void> => {
    const name = acceptedName(path);
    if (accepted === undefined) return await state.remove(acceptedConfigFile, name);
    try {
      await state.write(acceptedConfigFile, accepted, name);
    } catch (error) {
      if (!(error instanceof StoreDamagedError)) throw error;
      // The record is the daemon's own; one that cannot be read means nothing accepted, so it is replaced.
      await state.remove(acceptedConfigFile, name);
      await state.write(acceptedConfigFile, accepted, name);
    }
  };

  const readDisk = async (path: string): Promise<DiskState> => {
    const absolute = `${root}/${path}`;
    let info: Awaited<ReturnType<HostFs['info']>>;
    try {
      info = await fs.info(absolute);
    } catch {
      return { kind: 'unreadable' };
    }
    if (info === undefined) return { kind: 'absent' };
    if (!info.regularFile || info.size > CONFIG_FILE_MAX_BYTES) return { kind: 'unreadable' };
    try {
      const text = await fs.readText(absolute);
      return text === undefined ? { kind: 'absent' } : { kind: 'text', text };
    } catch {
      return { kind: 'unreadable' };
    }
  };

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
    const extra: ConfigIssue[] = [];
    const slots = await gatherSlots(extra);
    const now = options.clock.nowMs();
    const next = new Map<string, Settled>();
    for (const slot of slots) {
      const disk = await readDisk(slot.path);
      const stored = await readAccepted(slot.path);
      let accepted = stored;
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
      });
      if (JSON.stringify(evaluated.accepted) !== JSON.stringify(stored))
        await writeAccepted(slot.path, evaluated.accepted);
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
      fileState(def, name): ConfigFileStatus {
        own(def);
        const declaration = declared(pluginId, def as ConfigDef) as ConfigDeclaration;
        const slot = slotFor(declaration, name);
        return statusOf(slot === undefined ? undefined : settled.get(slot.path)?.evaluated);
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
      remove: async (def, name, writeOptions = {}): Promise<ConfigWriteOutcome> =>
        await removeOutcome(pluginId, def as ConfigDef, name, {
          judge: ownJudge(pluginId, () => pathOf(pluginId, def as ConfigDef, name)),
          ...(writeOptions.ifMatch === undefined ? {} : { ifMatch: writeOptions.ifMatch }),
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

  /** The text a patch makes of the file: only the changed keys are rewritten, so comments and order survive. */
  const patched = (
    slot: Slot,
    existing: string | undefined,
    patch: Readonly<Record<string, unknown>>,
  ): string | undefined => {
    const { def } = slot.declaration;
    const read = readConfigText(existing ?? '');
    const written = read.ok ? read.read.value : {};
    if (typeof written !== 'object' || written === null || Array.isArray(written)) return undefined;
    const meaning = def.schema.safeParse(written);
    const current = (meaning.success ? meaning.data : written) as Record<string, unknown>;
    const target: Record<string, unknown> = { ...current, ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete target[key];
    return editConfigText(existing, target, current, schemaModeline(def, slot.path));
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
    return await serial(async () => {
      const absolute = `${root}/${slot.path}`;
      const disk = await readDisk(slot.path);
      const existing = disk.kind === 'text' ? disk.text : undefined;
      const text = typeof edit === 'string' ? edit : patched(slot, existing, edit.patch);
      if (text === undefined) return { kind: 'refused', reason: 'not_a_mapping', issues: [] };
      const checked = checkConfigText(def, slot.path, text, binary);
      if (!checked.ok) return { kind: 'refused', reason: checked.reason, issues: checked.issues };
      const found = existing === undefined ? ABSENT_CONFIG_ETAG : digest(existing);
      if (writeOptions.ifMatch !== undefined && writeOptions.ifMatch !== found)
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
      const etag = digest(text);
      const before = settled.get(slot.path)?.evaluated.value;
      const unchanged = etag === settled.get(slot.path)?.evaluated.inEffect?.etag;
      const added =
        unchanged || writeOptions.byPlugin !== true ? [] : addedSecretReferenceSentences(before, checked.value);
      const loosens = unchanged ? [] : [...judgeLoosening(def, before, checked.value), ...added];
      const confirmed =
        added.length === 0 &&
        (writeOptions.confirmedLoosening === true || (loosens.length > 0 && askJudge(writeOptions, loosens, false)));
      if (loosens.length === 0 || confirmed) acknowledge(slot.path, text);
      await fs.writeAtomic(absolute, text, PRIVATE_FILE_MODE);
      await load();
      const held = settled.get(slot.path)?.evaluated.held;
      return held !== undefined && held.etag === etag
        ? { kind: 'held', etag, id: idOf(slot.path, etag), sentences: held.sentences }
        : { kind: 'applied', etag, text, loosened: confirmed ? loosens : [] };
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
    return { kind: 'refused', reason: removed.reason, issues: [] };
  };

  const confirm = async (id: string): Promise<boolean> =>
    await serial(async () => {
      await load();
      const held = heldOf(settled).find(item => item.id === id);
      if (held === undefined) return false;
      const found = settled.get(held.path);
      await writeAccepted(
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
    remove,
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
        return {
          path: view.path,
          exists: view.exists,
          text: view.text,
          etag: view.etag,
          status: statusOf(settled.get(slot.path)?.evaluated),
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
