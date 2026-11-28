/**
 * The import planner: what a scan of the host's Claude Code and Codex setups becomes in the account model (`planImport`),
 * and the configuration after an import (`mergeImport`, `mergeImportRecord`). Split from `import.ts`, which keeps the words
 * (the scan, the plan's shapes, the harvest of each document) this planner reads. Pure: documents in, a plan out.
 */
import { secretReferencesIn } from '@ferretry/core-vault/contract';
import type { RuntimesHarnessKit } from '../../../contract/index.ts';
import { harnessNamed, keepScope, ownMcpItem } from './import-scope.ts';
import { supportedKinds, UnsupportedHarnessError } from '../harness-kind.ts';
import type { HarnessKind } from '../manifest.ts';
import { NO_STARTERS } from '../models/catalog.ts';
import {
  type Candidate,
  credentialOf,
  EMPTY_IMPORT_RECORD,
  freeName,
  type HarnessHarvest,
  type HarnessImportPreview,
  harnessCandidates,
  harvest,
  type HostHarnessScan,
  IMPORT_NAMES,
  type ImportDuplicate,
  type ImportedComponent,
  type ImportedLoginEnv,
  type ImportedSecret,
  type ImportFile,
  type ImportNote,
  type ImportOptions,
  type ImportPlan,
  type ImportPreview,
  type ImportRecord,
  type ImportRecordEntry,
  type ImportUpdate,
  importedRuntimeName,
  instructionsCandidates,
  LAYER_ORDER,
  loginNote,
  mcpCandidates,
  referenceOf,
  SecretNames,
  skillsCandidates,
} from './import.ts';
import { builtinDocument, builtinProfileName } from './builtin-autonomous.ts';
import { HARNESS_DISPLAY_NAMES } from './layering.ts';
import { componentScope, scopeFits } from './scope.ts';
import {
  type AccountModel,
  type AccountModelDocument,
  type ComponentKind,
  type Credential,
  isRuntimeName,
  type LayeredProfile,
  type LayerReferenceText,
  parseAccountModel,
  parseLayerReference,
  type Runtime,
} from './schema.ts';

/** The digest of the instructions text held here, in the form an import records (scope, then text). */
function localInstructionsDigest(
  existing: AccountModel | undefined,
  name: string,
  digest: (text: string) => string,
): string | undefined {
  const local = existing?.components.instructions[name];
  if (local === undefined) return undefined;
  return digest(`${JSON.stringify(local.harness === undefined ? {} : { harness: local.harness })}\n${local.text}`);
}

/** The harness Runtimes lists first: the one a note about shared text is attributed to when the text belongs to none. */
const FIRST_HARNESS = supportedKinds()[0] as HarnessKind;

/** The installed harnesses a scan list should import, in a stable order. */
const importedHarnesses = (scans: readonly HostHarnessScan[], include?: readonly HarnessKind[]): HarnessKind[] =>
  supportedKinds().filter(
    harness =>
      scans.some(scan => scan.harness === harness && scan.command !== undefined) &&
      (include === undefined || include.includes(harness)),
  );

function previewOf(
  scan: HostHarnessScan,
  entry: HarnessHarvest | undefined,
  kit: RuntimesHarnessKit | undefined,
): HarnessImportPreview {
  const base = {
    harness: scan.harness,
    installed: scan.command !== undefined,
    account: scan.login,
    missingCommands: [...scan.missingCommands],
  };
  if (entry === undefined) {
    return {
      ...base,
      mcpServers: [],
      skills: [],
      codexProfiles: [],
      projectInstructions: [...(scan.projectInstructions ?? [])],
      secretKeys: [],
      problems: [...scan.problems],
    };
  }
  return {
    ...base,
    ...(scan.instructions.kind === 'text' && entry.instructions !== undefined
      ? {
          instructions: {
            name: kit?.importSetup?.instructionsName ?? '',
            source: scan.instructions.source,
            bytes: scan.instructions.bytes,
          },
        }
      : {}),
    ...(entry.settings !== undefined || entry.hooks !== undefined
      ? {
          settings: {
            source: entry.settings?.source ?? entry.hooks?.source ?? scan.settings.source,
            count: entry.settings?.count ?? 0,
            hooks: entry.hooks?.count ?? 0,
          },
        }
      : {}),
    mcpServers: entry.mcp.map(server => server.name),
    skills: entry.skills.map(skill => skill.item),
    codexProfiles: [...entry.codexProfiles],
    projectInstructions: [...(scan.projectInstructions ?? [])],
    secretKeys: [...entry.secretKeys, ...entry.gatedKeys],
    problems: [...entry.problems],
  };
}

/**
 * Holds, before any harvest starts, the kit of every requested harness, refusing one whose plugin lacks what planning
 * needs: a refused plan then has run no harvest for the harnesses that were fine.
 */
function requireImportKits(
  harnesses: readonly HarnessKind[],
  kits: ImportOptions['kits'],
): ReadonlyMap<HarnessKind, RuntimesHarnessKit> {
  const held = new Map<HarnessKind, RuntimesHarnessKit>();
  for (const harness of harnesses) {
    const kit = kits?.get(harness);
    if (kit?.importSetup === undefined || kit.harvest === undefined || kit.loginNote === undefined) {
      throw new UnsupportedHarnessError(harness);
    }
    held.set(harness, kit);
  }
  return held;
}

/**
 * Reads the host scans, a harness whose plugin offers no scan refused in the typed refusal of the route that asked (a 409,
 * like {@link planImportRefusing}) and any other failure as `unreadable`.
 */
export async function scansRefusing(
  scan: () => Promise<readonly HostHarnessScan[]>,
  refuse: (sentence: string) => Error,
  unreadable: (error: unknown) => Error,
): Promise<readonly HostHarnessScan[]> {
  try {
    return await scan();
  } catch (error) {
    throw error instanceof UnsupportedHarnessError ? refuse(error.message) : unreadable(error);
  }
}

/**
 * {@link planImport}, with a harness whose plugin gave no import kit refused in the typed refusal of the route that asked
 * (a 409): that is a plugin absent or partial, not a fault of this machine, so it is never an internal error.
 */
export function planImportRefusing(
  refuse: (sentence: string) => Error,
  scans: readonly HostHarnessScan[],
  options: ImportOptions,
): ImportPlan {
  try {
    return planImport(scans, options);
  } catch (error) {
    if (error instanceof UnsupportedHarnessError) throw refuse(error.message);
    throw error;
  }
}

/**
 * Plan an import of the given harnesses' setups (§4.3 steps 2–4, Import again).
 *
 * Total: a document that cannot be read becomes a problem sentence in the preview and the rest of
 * the harness still imports.
 */
export function planImport(scans: readonly HostHarnessScan[], options: ImportOptions): ImportPlan {
  const existing = options.existing;
  const record = options.record ?? EMPTY_IMPORT_RECORD;
  const names = new SecretNames(options.existingSecrets ?? [], options.reusableSecrets);
  const secrets: ImportedSecret[] = [];
  const imported = importedHarnesses(scans, options.include);
  const skip = new Set(options.skip ?? []);
  const ticked = new Set(options.tickedEnv ?? []);
  const kits = requireImportKits(imported, options.kits);
  const harvests = imported.map(harness =>
    harvest(
      scans.find(scan => scan.harness === harness) as HostHarnessScan,
      names,
      secrets,
      skip,
      ticked,
      options.starters ?? NO_STARTERS,
      kits.get(harness),
    ),
  );
  const harvestOf = (harness: HarnessKind) => harvests.find(entry => entry.harness === harness);

  const instructions = instructionsCandidates(harvests);
  const mcp = mcpCandidates(harvests);
  const skills = skillsCandidates(harvests);
  const candidates = [
    ...instructions.candidates,
    ...mcp.candidates,
    ...skills.candidates,
    ...harvests.flatMap(harnessCandidates),
  ];

  const notes: ImportNote[] = [];
  for (const entry of harvests) {
    const scan = scans.find(each => each.harness === entry.harness) as HostHarnessScan;
    notes.push({
      harness: entry.harness,
      text: loginNote(entry.harness, scan.login, kits.get(entry.harness)),
    });
    if (entry.secretKeys.length > 0) {
      notes.push({
        harness: entry.harness,
        text: `${String(entry.secretKeys.length)} secret value${entry.secretKeys.length === 1 ? '' : 's'} went to Ferretry's secret store and ${entry.secretKeys.length === 1 ? 'is' : 'are'} never shown: ${entry.secretKeys.join(', ')}.`,
      });
    }
  }
  for (const scan of scans) {
    if (scan.command === undefined) {
      notes.push({
        harness: scan.harness,
        text: `${HARNESS_DISPLAY_NAMES[scan.harness]} isn't installed · Install later in Settings.`,
      });
    }
  }
  if (instructions.identical !== undefined && instructions.compared !== undefined) {
    // The second harness's instructions, said against the first's own file.
    const first = kits.get(instructions.compared.first)?.importSetup?.instructionsName ?? '';
    notes.push({
      harness: instructions.compared.second,
      text: instructions.identical
        ? `Instructions: same as your ${first} · one shared copy.`
        : `Instructions: different from your ${first} · kept separately.`,
    });
  }
  notes.push(...mcp.notes, ...skills.notes);

  // Import again: keep what is new, offer what changed, leave what the person made alone.
  const components: ImportedComponent[] = [];
  const files: ImportFile[] = [];
  const keptSecrets = new Set<string>();
  const updates: ImportUpdate[] = [];
  const warnings: Record<string, readonly string[]> = {};
  const recordEntries: Record<string, ImportRecordEntry> = { ...record.components };
  const added: LayerReferenceText[] = [];
  const taken = (kind: ComponentKind, name: string): boolean =>
    existing?.components[kind][name] !== undefined || components.some(item => item.kind === kind && item.name === name);
  const secretsOf = (candidate: Candidate): ImportedSecret[] => {
    const referenced = new Set(secretReferencesIn(JSON.stringify(candidate.component.value)));
    return secrets.filter(secret => referenced.has(secret.name));
  };
  for (const original of candidates) {
    const candidate = ownMcpItem(original, existing);
    const { kind, name } = candidate.component;
    const reference = referenceOf(kind, name);
    const previous = record.components[reference];
    // What an earlier import left out is not compared: only what it imported can have changed.
    const comparable =
      previous?.left !== undefined && previous.left.length > 0 && candidate.without !== undefined
        ? candidate.without(new Set(previous.left))
        : candidate;
    const digest = options.digest(comparable.digestText);
    if (existing?.components[kind][name] !== undefined && previous !== undefined) {
      if (previous.digest !== digest) {
        // Instructions are Runtimes' own text: an update replaces them only while the text here is still what the last
        // import wrote (its digest is the recorded one). Text the person changed here is theirs and is left as it is.
        if (kind === 'instructions' && localInstructionsDigest(existing, name, options.digest) !== previous.digest) {
          notes.push({
            harness: existing.components.instructions[name]?.harness ?? FIRST_HARNESS,
            text: `Instructions "${name}": the host's file changed, but you changed them here, so they were left as they are.`,
          });
          continue;
        }
        const left = [...new Set([...(previous.left ?? []), ...(candidate.left ?? [])])];
        updates.push({
          reference,
          ...(left.length === 0 ? {} : { left }),
          sources: comparable.sources,
          component: keepScope(comparable.component, existing),
          files: comparable.files,
          secrets: secretsOf(comparable),
          digest,
        });
      }
      continue;
    }
    // A name the person already used for something of their own: the import takes the next free one.
    const free = freeName(name, candidate_ => taken(kind, candidate_));
    const component = { ...candidate.component, name: free } as ImportedComponent;
    const renamedFiles =
      free === name
        ? candidate.files
        : candidate.files.map(file =>
            file.kind === 'write' && file.path.startsWith(`components/${kind}/${name}.`)
              ? { ...file, path: file.path.replace(`/${name}.`, `/${free}.`) }
              : file,
          );
    const value = component.value as { file?: string };
    if (free !== name && value.file !== undefined) {
      (component as { value: { file?: string } }).value = {
        ...value,
        file: value.file.replace(`/${name}.`, `/${free}.`),
      };
    }
    components.push(component);
    files.push(...renamedFiles);
    for (const secret of secretsOf(candidate)) keptSecrets.add(secret.name);
    const freeReference = referenceOf(kind, free);
    added.push(freeReference);
    recordEntries[freeReference] = {
      sources: candidate.sources,
      digest,
      ...(candidate.left === undefined ? {} : { left: [...candidate.left] }),
    };
    if (candidate.warnings.length > 0) warnings[freeReference] = candidate.warnings;
  }

  // The profiles: ONE PER IMPORTED HARNESS (P7 — a profile is Generic, Claude only or Codex only,
  // never both), each holding the generic parts and that harness's own. Import again extends the
  // profile an earlier import made for a harness, or makes one for a harness imported for the first
  // time. A record written before P7 names one shared profile, which is extended as it always was.
  const anyFound = harvests.some(entry => entry.found);
  const profiles: Record<string, LayeredProfile> = {};
  const ordered = (layers: readonly LayerReferenceText[]): LayerReferenceText[] =>
    [...layers].sort(
      (left, right) =>
        LAYER_ORDER.indexOf(left.slice(0, left.indexOf('/')) as ComponentKind) -
        LAYER_ORDER.indexOf(right.slice(0, right.indexOf('/')) as ComponentKind),
    );
  const componentAt = (reference: string): unknown => {
    const parsed = parseLayerReference(reference);
    if (parsed?.kind !== 'component') return undefined;
    const made = components.find(item => item.kind === parsed.componentKind && item.name === parsed.name);
    return made === undefined ? existing?.components[parsed.componentKind][parsed.name] : made.value;
  };
  const fitsOn = (harness: HarnessKind) => (reference: LayerReferenceText) =>
    scopeFits(
      componentScope(reference.slice(0, reference.indexOf('/')) as ComponentKind, componentAt(reference)),
      harness,
    );
  const profileOf: Partial<Record<HarnessKind, string>> = {};
  // A harness an earlier import already brought in: its login has had its `env` already, so a repeat adds none (r9 A8).
  const importedBefore = new Set<HarnessKind>();
  for (const harness of imported) {
    const known = record.profiles?.[harness] ?? record.profile;
    if (known !== undefined && existing?.profiles[known] !== undefined) {
      profileOf[harness] = known;
      importedBefore.add(harness);
    }
  }
  for (const known of new Set(Object.values(profileOf))) {
    const on = imported.filter(harness => profileOf[harness] === known);
    const current = (existing as AccountModel).profiles[known];
    const before = current?.layers ?? [];
    const fresh = added.filter(
      reference => !before.includes(reference) && on.some(harness => fitsOn(harness)(reference)),
    );
    if (fresh.length > 0) profiles[known] = { ...current, layers: [...before, ...ordered(fresh)] };
  }
  for (const harness of imported) {
    if (profileOf[harness] !== undefined) continue;
    // A harness imported for the first time: what an earlier import made that fits it, then what is new.
    const earlier = Object.keys(record.components).filter(
      reference => !added.includes(reference as LayerReferenceText) && componentAt(reference) !== undefined,
    ) as LayerReferenceText[];
    const fitting = [...earlier, ...added].filter(fitsOn(harness));
    // Something found now, or something an earlier import found, is a Default; only model sets is a
    // Starter. Never empty: the harness's model set is always new or recorded.
    const found = anyFound || fitting.some(reference => !reference.startsWith('modelSets/'));
    // The built-in profile of the harness is the OLDEST layer, so whatever was found (or the starter model set) wins over it.
    const layers = [`profile/${builtinProfileName(harness)}` as LayerReferenceText, ...ordered(fitting)];
    const wanted = importedRuntimeName(harness, found ? IMPORT_NAMES.defaultProfile : IMPORT_NAMES.starterProfile);
    const name = freeName(
      wanted,
      candidate => existing?.profiles[candidate] !== undefined || profiles[candidate] !== undefined,
    );
    profiles[name] = { layers };
    profileOf[harness] = name;
    if (!found) {
      notes.push({
        harness,
        text: "Nothing found. A plain Starter profile: Ferretry's autonomous defaults and a model set. You can add to it later.",
      });
    }
  }

  // Credentials and runtimes.
  const credentials: Record<string, Credential> = {};
  const runtimes: Record<string, Runtime> = {};
  const duplicates: ImportDuplicate[] = [];
  const loginEnvs: ImportedLoginEnv[] = [];
  for (const harness of imported) {
    const scan = scans.find(each => each.harness === harness) as HostHarnessScan;
    const wanted = credentialOf(harness, scan.login);
    const reuse =
      wanted.store === 'host'
        ? Object.entries(existing?.credentials ?? {}).find(
            ([, credential]) => credential.harness === harness && credential.store === 'host',
          )?.[0]
        : undefined;
    // A retry of an import that already made this harness's runtime: that runtime, and the login it runs on (a Ferretry
    // login included, which a host login's reuse above never finds), carry through instead of a `-2` copy of each.
    const earlier = importedBefore.has(harness)
      ? Object.entries(existing?.runtimes ?? {}).find(
          ([, runtime]) =>
            runtime.profile === profileOf[harness] && existing?.credentials[runtime.credential]?.harness === harness,
        )?.[1]
      : undefined;
    const credentialId =
      earlier?.credential ??
      reuse ??
      freeName(harnessNamed(harness, 'you'), candidate => existing?.credentials[candidate] !== undefined);
    if (earlier === undefined && reuse === undefined) credentials[credentialId] = wanted;
    const env = importedBefore.has(harness) ? undefined : harvestOf(harness)?.loginEnv;
    if (env !== undefined) {
      // An unticked GitHub token never got here: it was left out of the harvest, before any secret was claimed.
      for (const entry of env.minted) keptSecrets.add(entry.secretName);
      loginEnvs.push({ harness, login: credentialId, plain: env.plain, minted: env.minted });
    }
    const profileName = profileOf[harness];
    if (profileName === undefined) continue;
    const suggested = freeName(
      profileName.startsWith(`${harness}-`) ? profileName : importedRuntimeName(harness, profileName),
      candidate => existing?.runtimes[candidate] !== undefined || runtimes[candidate] !== undefined,
    );
    const twin = Object.entries(existing?.runtimes ?? {}).find(
      ([, runtime]) => runtime.credential === credentialId && runtime.profile === profileName,
    )?.[0];
    if (twin !== undefined && !(options.addDuplicates ?? []).includes(harness)) {
      duplicates.push({ harness, existing: twin, suggested });
      continue;
    }
    if (!isRuntimeName(suggested)) continue;
    runtimes[suggested] = { credential: credentialId, profile: profileName };
  }

  const recordedProfiles: Partial<Record<HarnessKind, string>> = { ...record.profiles, ...profileOf };

  const preview: ImportPreview = {
    harnesses: scans.map(scan => previewOf(scan, harvestOf(scan.harness), kits.get(scan.harness))),
    ...(instructions.identical === undefined ? {} : { instructionsIdentical: instructions.identical }),
  };

  return {
    preview,
    imported,
    credentials,
    components,
    profiles,
    runtimes,
    files,
    secrets: secrets.filter(secret => keptSecrets.has(secret.name)),
    loginEnvs,
    warnings,
    notes,
    updates,
    duplicates,
    starters: options.starters ?? NO_STARTERS,
    record: {
      version: 1,
      components: recordEntries,
      ...(record.profile === undefined ? {} : { profile: record.profile }),
      ...(Object.keys(recordedProfiles).length === 0 ? {} : { profiles: recordedProfiles }),
    },
  };
}

/** A configuration to import into when the machine has none yet. */
const EMPTY_MODEL: AccountModelDocument = { version: 1 };

/**
 * The configuration after an import: what is there, plus what the plan adds, plus each offered
 * update the person ACCEPTED (O6 — an update is never applied unless named here). Parsed, so a plan
 * that would make an invalid document is refused here rather than written.
 */
export function mergeImport(
  existing: AccountModel | undefined,
  plan: ImportPlan,
  acceptedUpdates: readonly LayerReferenceText[] = [],
): AccountModel {
  // A machine with no files has no model to read the built-in profiles from, and an imported profile names one as its base.
  const base = (existing ?? parseAccountModel({ ...EMPTY_MODEL, ...builtinDocument(plan.starters) })) as AccountModel;
  const components = Object.fromEntries(
    Object.entries(base.components).map(([kind, entries]) => [kind, { ...entries }]),
  ) as Record<ComponentKind, Record<string, unknown>>;
  const accepted = plan.updates.filter(update => acceptedUpdates.includes(update.reference));
  for (const component of [...plan.components, ...accepted.map(update => update.component)]) {
    components[component.kind][component.name] = component.value;
  }
  return parseAccountModel({
    ...base,
    credentials: { ...base.credentials, ...plan.credentials },
    components,
    profiles: { ...base.profiles, ...plan.profiles },
    runtimes: { ...base.runtimes, ...plan.runtimes },
  });
}

/** The record after an import, including each accepted update's new digest. */
export function mergeImportRecord(plan: ImportPlan, acceptedUpdates: readonly LayerReferenceText[] = []): ImportRecord {
  const components: Record<string, ImportRecordEntry> = { ...plan.record.components };
  for (const update of plan.updates) {
    if (acceptedUpdates.includes(update.reference)) {
      components[update.reference] = {
        sources: update.sources,
        digest: update.digest,
        ...(update.left === undefined ? {} : { left: update.left }),
        ...(plan.record.components[update.reference]?.owned === undefined
          ? {}
          : { owned: plan.record.components[update.reference]?.owned }),
        ...(plan.record.components[update.reference]?.etags === undefined
          ? {}
          : { etags: plan.record.components[update.reference]?.etags }),
      };
    }
  }
  return { ...plan.record, components };
}
