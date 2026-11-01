/**
 * The whole configuration directory, evaluated: what is in effect, what is wrong, and what waits for
 * the owner's confirmation (docs/config-files.md).
 *
 * THREE RULES, in this order, for every file:
 *
 * 1. **Last good wins.** A file that does not parse, holds a raw secret or breaks its schema is
 *    reported, located, and its LAST GOOD version stays in effect — the one the daemon accepted
 *    before, kept in the state home. A file never half-applies: either all of it is in effect or none.
 * 2. **Loosening waits.** A valid edit that loosens what this machine may spend or what its agents may
 *    do (`./kinds.ts`) is held: the tighter version stays in effect until the owner confirms the edit
 *    by its etag. Tightening applies at once. Deleting a file is an edit to its defaults, judged the
 *    same way.
 * 3. **The fleet is all or nothing.** The fleet's files are assembled into one account model and
 *    checked together; if a cross-file rule fails, the issue is reported on the file it is about and
 *    the fleet keeps the model it had, so a runtime is never left pointing at a profile that is gone.
 *
 * "Accepted" is the record of what the daemon put into effect, file by file, with the text it was in
 * effect as. A file whose etag matches its accepted entry is in effect as written without a loosening
 * check: the owner has already confirmed it, or the daemon wrote it on the owner's behalf.
 *
 * Pure: the caller reads the directory and the accepted record, and stores the next record.
 */
import {
  type ConfigFileAddress,
  type ConfigFileState,
  type ConfigFileSummary,
  type ConfigIssue,
  type ConfigPending,
  classifyConfigPath,
  configFilePath,
  configSchemaId,
  type AccountDefaultsFile,
  type LearningConfig,
  type ModelsGuideFile,
  type PackConfig,
  type VoiceConfig,
  type WardenConfig,
} from '@ferretry/protocol';
import { z } from 'zod';
import type { AccountModel } from '../account/schema.ts';
import type { ModelCatalog, ModelCatalogFile } from '../models/schema.ts';
import { type ProviderPreset, type ProviderPresetFile, presetFromFile } from '../presets/schema.ts';
import { type CheckedConfigFile, checkConfigFile, schemaIssues } from './check.ts';
import {
  type ConfigValues,
  configLoosening,
  loginLoosening,
  runtimeLoosening,
  SINGLETON_DEFAULTS,
  type SingletonKind,
} from './kinds.ts';
import { assembleAccountModel, type FleetFileValue, isFleetFile, modelIssueSite } from './model.ts';

/** One file found in the directory, by its path relative to it. */
export interface ConfigFileText {
  readonly path: string;
  readonly text: string;
}

/** What the daemon put into effect for one file: the text, and its etag. */
export interface AcceptedConfigFile {
  readonly etag: string;
  readonly text: string;
}

/** The accepted record, by path. */
export const AcceptedConfigFilesSchema = z.record(
  z.string(),
  z.strictObject({ etag: z.string().min(1), text: z.string() }),
);
export type AcceptedConfigFiles = Readonly<Record<string, AcceptedConfigFile>>;

/** The etag a file that does not exist has: the provisioner's absent revision. */
export const ABSENT_CONFIG_ETAG = 'absent';

export interface ConfigEvaluationInput {
  /** Every file under the directory that ends `.yaml` or `.yml`, the schema directory excluded. */
  readonly files: readonly ConfigFileText[];
  /**
   * Files found but not read: a link (never followed — a link in the config directory could point a
   * reader at any file on the machine) or one too large. Each keeps its last good version.
   */
  readonly unreadable?: readonly string[];
  readonly accepted: AcceptedConfigFiles;
  /** A file's etag: sha256 of its UTF-8 bytes, hex — the provisioner's revision, so the two agree. */
  digest(text: string): string;
}

/** Everything in effect. */
export interface EffectiveConfig {
  readonly model: AccountModel;
  readonly warden: WardenConfig;
  readonly learning: LearningConfig;
  readonly voice: VoiceConfig;
  readonly pack: PackConfig;
  /** The guide as written; `useCases` absent means the one derived from the catalogs (docs/pack-mode.md). */
  readonly modelsGuide: ModelsGuideFile;
  /** Which account a sign-in card offers first (`account-defaults.yaml`); the owner's lines only, every change held. */
  readonly accountDefaults: AccountDefaultsFile;
  /** This machine's own provider presets (`presets/<id>.yaml`), by id. The built-ins are not here. */
  readonly presets: Readonly<Record<string, ProviderPreset>>;
  /** This machine's own model catalogs (`models/<id>.yaml`), by id: each wins over the published and built-in one. */
  readonly modelCatalogs: Readonly<Record<string, ModelCatalog>>;
}

export interface ConfigEvaluation {
  readonly effective: EffectiveConfig;
  /** Whether any fleet file is in effect at all: a machine with none has not been set up. */
  readonly fleetFiles: number;
  /** A digest of the fleet files in effect: moves exactly when the account model in effect moves. */
  readonly fleetRevision: string;
  /** The record to store for the next evaluation. */
  readonly accepted: AcceptedConfigFiles;
  readonly files: readonly ConfigFileSummary[];
  readonly issues: readonly ConfigIssue[];
  readonly pending: readonly ConfigPending[];
}

/** One file's candidate for being in effect, and the text it would be in effect as. */
interface Candidate {
  readonly checked: CheckedConfigFile;
  readonly text: string;
  readonly etag: string;
}

const isSingleton = (address: ConfigFileAddress): address is { readonly kind: SingletonKind } =>
  address.kind in SINGLETON_DEFAULTS;

/** What a singleton means, given its candidate (or its defaults when there is none). */
const singletonValue = <K extends SingletonKind>(kind: K, candidate: Candidate | undefined) =>
  (candidate?.checked.value ?? SINGLETON_DEFAULTS[kind]) as (typeof SINGLETON_DEFAULTS)[K];

/** A stored accepted entry, re-checked: a release that changed a schema can retire an old good file. */
function acceptedCandidate(path: string, accepted: AcceptedConfigFile | undefined): Candidate | undefined {
  if (accepted === undefined) return undefined;
  const checked = checkConfigFile(path, accepted.text);
  return checked.ok ? { checked, text: accepted.text, etag: accepted.etag } : undefined;
}

/** Evaluate the directory. Total: every problem is an issue, never a throw. */
export function evaluateConfigFiles(input: ConfigEvaluationInput): ConfigEvaluation {
  const issues: ConfigIssue[] = [];
  const pending: ConfigPending[] = [];
  const states = new Map<string, { address: ConfigFileAddress; state: ConfigFileState }>();
  const next: Record<string, AcceptedConfigFile> = {};
  /** What is in effect for each path this round. */
  const effective = new Map<string, Candidate>();
  /** Fleet paths whose entry in `next` changed this round, to undo if the fleet does not assemble. */
  const fleetChanges = new Set<string>();

  /** The logins with a budget in effect before this round: what a runtime may not leave unconfirmed. */
  const budgeted = new Set(
    Object.entries(input.accepted).flatMap(([path, accepted]) => {
      const candidate = acceptedCandidate(path, accepted);
      if (candidate === undefined || candidate.checked.address.kind !== 'login') return [];
      const login = candidate.checked.value as ConfigValues['login'];
      return login.budget === undefined ? [] : [candidate.checked.address.name];
    }),
  );
  /** The budget edits a file makes, against what was in effect: `after` absent is the file deleted. */
  const budgetLoosening = (address: ConfigFileAddress, before: Candidate | undefined, after: Candidate | undefined) => {
    if (address.kind === 'login')
      return loginLoosening(
        address.name,
        before?.checked.value as ConfigValues['login'] | undefined,
        after?.checked.value as ConfigValues['login'] | undefined,
      );
    if (address.kind === 'runtime')
      return runtimeLoosening(
        address.name,
        before?.checked.value as ConfigValues['runtime'] | undefined,
        after?.checked.value as ConfigValues['runtime'] | undefined,
        login => budgeted.has(login),
      );
    return [];
  };

  const unreadable = input.unreadable ?? [];
  const onDisk = new Set([...input.files.map(file => file.path), ...unreadable]);
  for (const path of unreadable) {
    const address = classifyConfigPath(path);
    issues.push({
      path,
      // A link that is not a config file's name (a linked `logins/` directory) keeps nothing in effect,
      // but a person who made it expects it to be read, so it is still said.
      severity: address === undefined ? 'warning' : 'error',
      message: 'this file is not read: it is a link, or larger than the 256 KiB a configuration file may be',
      fix: 'make it an ordinary file (a copy, not a link) of a sensible size',
    });
    if (address === undefined) continue;
    states.set(path, { address, state: 'invalid' });
    const previous = acceptedCandidate(path, input.accepted[path]);
    if (previous === undefined) continue;
    effective.set(path, previous);
    next[path] = { etag: previous.etag, text: previous.text };
  }
  for (const file of [...input.files].toSorted((left, right) => left.path.localeCompare(right.path))) {
    const checked = checkConfigFile(file.path, file.text);
    issues.push(...checked.issues);
    if (checked.address === undefined) continue;
    const address = checked.address;
    const previous = acceptedCandidate(file.path, input.accepted[file.path]);
    const keepPrevious = (state: ConfigFileState): void => {
      states.set(file.path, { address, state });
      if (previous === undefined) return;
      effective.set(file.path, previous);
      next[file.path] = { etag: previous.etag, text: previous.text };
    };
    if (!checked.ok) {
      keepPrevious('invalid');
      continue;
    }
    const etag = input.digest(file.text);
    const candidate: Candidate = { checked, text: file.text, etag };
    if (isSingleton(address) && etag !== previous?.etag) {
      const changes = configLoosening(
        address.kind,
        singletonValue(address.kind, previous),
        singletonValue(address.kind, candidate),
      );
      if (changes.length > 0) {
        pending.push({ path: file.path, etag, changes: [...changes] });
        keepPrevious('pending');
        continue;
      }
    }
    if (etag !== previous?.etag) {
      const changes = budgetLoosening(address, previous, candidate);
      if (changes.length > 0) {
        pending.push({ path: file.path, etag, changes: [...changes] });
        keepPrevious('pending');
        continue;
      }
    }
    states.set(file.path, { address, state: 'ok' });
    effective.set(file.path, candidate);
    next[file.path] = { etag, text: file.text };
    if (isFleetFile(address) && etag !== previous?.etag) fleetChanges.add(file.path);
  }

  // A file that was in effect and is gone: a deletion, which is an edit to the defaults.
  for (const [path, accepted] of Object.entries(input.accepted)) {
    if (onDisk.has(path)) continue;
    const previous = acceptedCandidate(path, accepted);
    if (previous === undefined) continue;
    const address = previous.checked.address;
    if (isSingleton(address)) {
      const changes = configLoosening(
        address.kind,
        singletonValue(address.kind, previous),
        SINGLETON_DEFAULTS[address.kind],
      );
      if (changes.length > 0) {
        pending.push({ path, etag: ABSENT_CONFIG_ETAG, changes: [...changes] });
        states.set(path, { address, state: 'pending' });
        effective.set(path, previous);
        next[path] = accepted;
        continue;
      }
    }
    // A budgeted login deleted, or a runtime deleted off one, is a budget removed: held like any removal.
    const changes = budgetLoosening(address, previous, undefined);
    if (changes.length > 0) {
      pending.push({ path, etag: ABSENT_CONFIG_ETAG, changes: [...changes] });
      states.set(path, { address, state: 'pending' });
      effective.set(path, previous);
      next[path] = accepted;
      continue;
    }
    if (isFleetFile(address)) fleetChanges.add(path);
  }

  const fleet = assembleFleet(input, effective, next, fleetChanges, states, issues);

  const singleton = <K extends SingletonKind>(kind: K) =>
    singletonValue(kind, effective.get(configFilePath({ kind } as ConfigFileAddress)));
  const fleetPaths = [...effective.entries()]
    .filter(([, candidate]) => isFleetFile(candidate.checked.address))
    .map(([path, candidate]) => `${path}\u0000${candidate.etag}`)
    .toSorted();
  return {
    effective: {
      model: fleet,
      warden: singleton('warden'),
      learning: singleton('learning'),
      voice: singleton('voice'),
      pack: singleton('pack'),
      modelsGuide: singleton('modelsGuide'),
      accountDefaults: singleton('accountDefaults'),
      presets: Object.fromEntries(
        [...effective.values()].flatMap(candidate => {
          const address = candidate.checked.address;
          if (address.kind !== 'preset') return [];
          const preset = candidate.checked.value as ProviderPresetFile;
          return [[address.name, presetFromFile(address.name, preset, 'file')]];
        }),
      ),
      modelCatalogs: Object.fromEntries(
        [...effective.values()].flatMap(candidate => {
          const address = candidate.checked.address;
          if (address.kind !== 'models') return [];
          const catalog = candidate.checked.value as ModelCatalogFile;
          return [[address.name, { ...catalog, id: address.name, origin: 'file' as const }]];
        }),
      ),
    },
    fleetFiles: fleetPaths.length,
    fleetRevision: fleetPaths.length === 0 ? ABSENT_CONFIG_ETAG : input.digest(fleetPaths.join('\n')),
    accepted: next,
    files: [...states.entries()]
      .map(([path, { address, state }]) => ({ path, kind: address.kind, schema: configSchemaId(address), state }))
      .toSorted((left, right) => left.path.localeCompare(right.path)),
    issues,
    pending,
  };
}

/**
 * Assemble the fleet's files into one model. When a cross-file rule fails, every fleet change made
 * this round is undone — `effective` and `next` go back to what was accepted — the issue is reported
 * on the file it is about, and the previous model is assembled instead.
 */
function assembleFleet(
  input: ConfigEvaluationInput,
  effective: Map<string, Candidate>,
  next: Record<string, AcceptedConfigFile>,
  changes: ReadonlySet<string>,
  states: Map<string, { address: ConfigFileAddress; state: ConfigFileState }>,
  issues: ConfigIssue[],
): AccountModel {
  const values = (): FleetFileValue[] =>
    [...effective.values()]
      .filter(candidate => isFleetFile(candidate.checked.address))
      .map(candidate => ({ address: candidate.checked.address, value: candidate.checked.value }));
  try {
    return assembleAccountModel(values());
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    const blamed = new Set<string>();
    for (const issue of error.issues) {
      const site = modelIssueSite(issue.path);
      const candidate = effective.get(site.file);
      blamed.add(site.file);
      issues.push(
        ...schemaIssues(site.file, new z.ZodError([{ ...issue, path: site.path as PropertyKey[] }]), path =>
          candidate?.checked.locate(path),
        ),
      );
    }
    for (const path of changes) {
      const previous = acceptedCandidate(path, input.accepted[path]);
      if (previous === undefined) {
        effective.delete(path);
        delete next[path];
      } else {
        effective.set(path, previous);
        next[path] = input.accepted[path] as AcceptedConfigFile;
      }
      const state = states.get(path);
      if (state !== undefined) states.set(path, { ...state, state: 'invalid' });
      if (!blamed.has(path)) {
        issues.push({
          path,
          severity: 'warning',
          message: `not in effect yet: this machine keeps its last good fleet until ${[...blamed].toSorted().join(', ')} is fixed`,
          fix: `fix ${[...blamed].toSorted().join(', ')} first`,
        });
      }
    }
    for (const path of blamed) {
      const state = states.get(path);
      if (state !== undefined) states.set(path, { ...state, state: 'invalid' });
    }
    try {
      return assembleAccountModel(values());
    } catch {
      // The accepted record itself no longer assembles (a release changed a rule): nothing is safer
      // to run than nothing, and every issue above says why.
      return assembleAccountModel([]);
    }
  }
}
