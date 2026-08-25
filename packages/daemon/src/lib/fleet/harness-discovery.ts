/**
 * What this host already knows about a harness, so the account form does not ask a person for it.
 *
 * THE DETECTION IS NOT NEW. `readHarnessPreflight` has resolved `claude` and `codex` against this
 * host's `PATH` since the first boot milestone, and said so in the startup warning; what it never did
 * was OFFER that answer to anything a person types into. This module surfaces the same lookup, from
 * the same port, and adds the two further facts a form needs and a preflight has no use for: the
 * models the harness's own settings already name, and the instructions document it already reads.
 *
 * FOUR RULES, and each one exists because the opposite choice ships a lie:
 *
 *  1. **Nothing is launched.** Every answer comes from a `PATH` lookup and at most two file reads, so
 *     the report is cheap enough to serve on a form open and can never hang on a harness that wants
 *     to talk to a provider. The cost is that it cannot prove a harness is signed in, and the report
 *     carries that limit in its own text rather than trusting a surface to remember it.
 *  2. **A detected value names the file it came from.** A prefilled box a person cannot trace is worse
 *     than an empty one: they cannot tell a detection from a guess, so they must re-check everything,
 *     which is the typing this exists to remove.
 *  3. **A fallback says it is one.** When a harness declares no model, the form still needs something
 *     selectable, and the honest something is the product's own starter model — the same identifier
 *     `fy fleet init --first-account` writes, taken from the fleet package so there is one owner of it.
 *     A model this module invented would let an account claim to serve something no session can start.
 *  4. **Absence is stated, never blank.** "There is no such file", "it is too large to import", "it
 *     would not parse" and "we could not read it" send a reader to four different places, so they are
 *     four different sentences rather than one empty field.
 *
 * THE HOME LAYOUT IS INJECTED. Where Claude Code and Codex keep their settings and their instructions
 * is a fact about a real machine, so it arrives as a value — the same shape the foreign-history
 * importer uses for the same reason. Nothing here names a user's home, which is also what lets every
 * branch below be proved against fixture paths.
 */

import { FLEET_STARTER_MODELS, parseSettings, type SettingsFormat } from '@ferretry/fleet';
import type { HarnessDiscovery, HarnessDiscoveryReport, HarnessInstructions, HarnessModels } from '@ferretry/protocol';
import type { HarnessKind } from '../core/inventory.ts';

/**
 * Where one harness keeps what this report reads.
 *
 * `instructionsName` is carried rather than derived from the path so the sentences below can name the
 * document the way its own harness does — a person looking for why `AGENTS.md` was offered is looking
 * for that word, not for a basename this module reconstructed.
 */
export interface HarnessHomeLayout {
  readonly kind: HarnessKind;
  /** The harness's own settings document on this host, absolute. */
  readonly settingsPath: string;
  readonly settingsFormat: SettingsFormat;
  /** The instructions document this harness reads on this host, absolute. */
  readonly instructionsPath: string;
  /** What that document is called in the harness's own words: `CLAUDE.md`, `AGENTS.md`. */
  readonly instructionsName: string;
}

/** One read of a document OUTSIDE the state home, classified rather than thrown. */
export type HarnessDocumentRead =
  | { readonly kind: 'text'; readonly text: string; readonly bytes: number }
  | { readonly kind: 'absent' }
  /** Larger than the ceiling. Reported rather than truncated: half an instructions file is a trap. */
  | { readonly kind: 'too-large'; readonly bytes: number }
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * Reading a harness's own home.
 *
 * A PORT, and a deliberately separate one from the state filesystem: that port refuses every path
 * outside `FY_HOME`, which is exactly right for it and exactly wrong here — a harness home is
 * somebody's `~`, and the whole point of this read is that it is not Ferretry's own tree.
 */
export interface HarnessHomeDocuments {
  /** Reads at most `maxBytes`; anything larger is `too-large`, never a truncated `text`. */
  read(path: string, maxBytes: number): Promise<HarnessDocumentRead>;
}

/**
 * Resolving a bare command name against this host's `PATH`. The preflight's own port, narrowed.
 *
 * Not exported: a caller supplies it as part of {@link HarnessDiscoveryOptions} and never needs to name
 * the type, so exporting it would be a name nothing imports.
 */
interface HarnessCommandResolver {
  resolve(name: string): string | undefined;
}

/**
 * The report, as the fleet mount consumes it.
 *
 * A PORT rather than the function itself, because assembling it needs the two things a mount may not
 * reach for: this host's real harness homes and a reader that leaves the state home. The composition
 * root supplies both, and a route test drives a fixed report without a filesystem.
 *
 * Read FRESH on every call. A harness installed, configured or re-modelled after this daemon started
 * is exactly the case a person hits when they install Claude Code and come straight back to the form.
 */
export interface HarnessDiscoveryReader {
  report(): Promise<HarnessDiscoveryReport>;
}

export interface HarnessDiscoveryOptions {
  readonly layouts: readonly HarnessHomeLayout[];
  readonly executables: HarnessCommandResolver;
  readonly documents: HarnessHomeDocuments;
  /**
   * The ceiling one fleet asset may carry, passed in rather than imported.
   *
   * The number belongs to the asset rules, and importing it here would make this module a second
   * place that has an opinion about how big an asset may be. Offering text a proposal would then
   * refuse is the specific failure that avoids.
   */
  readonly maxDocumentBytes: number;
}

/**
 * The settings key both harnesses spell the same way.
 *
 * Claude Code reads `model` from its `settings.json`; Codex reads `model` from its `config.toml`.
 * One name, two formats — which is why the FORMAT is a layout fact and the KEY is not.
 */
const MODEL_KEY = 'model';

/**
 * An environment name that names a model.
 *
 * A RULE RATHER THAN A TABLE, and that is the whole point. Claude Code takes several model
 * identifiers through its settings `env` block — a primary, a small fast one, a per-family default —
 * and a hardcoded list of those names would be this repository claiming to know a harness's
 * environment surface. It would also go stale silently: a name the harness added would simply never
 * be offered, and nothing would say so. A name ending in `MODEL` holds a model identifier in every
 * spelling either harness uses, so the rule finds them all, and it can never invent one — every
 * candidate it yields is a value somebody wrote in that file.
 */
const MODEL_ENV_NAME = /(^|_)MODEL$/u;

/** Codex declares a model per named profile, which is a second — and equally declared — place to look. */
const PROFILES_KEY = 'profiles';

/** What the sentence below has to tell a reader when nothing named a model, since the rule is otherwise invisible. */
const MODEL_SOURCES = `"${MODEL_KEY}", an env name ending in MODEL, or a profile's own "${MODEL_KEY}"`;

const trimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Every model identifier one settings document names, in preference order and without repeats.
 *
 * THE HARNESS'S OWN `model` IS FIRST, because it is the one the harness would use if nobody chose
 * and {@link HarnessModels.defaultModel} has to be one of these. The rest are the further models the
 * SAME document already names: an `env` entry whose name ends in `MODEL`, and the model each named
 * profile declares. Both extra keys are read for both harnesses for the reason {@link MODEL_KEY} is
 * not a layout fact — a per-harness table of where to look is a second declaration that can go stale
 * against a harness, where a rule applied uniformly cannot.
 *
 * WHY IT MATTERS: before this, a fresh host offered the account form exactly ONE card and every
 * further model had to be typed in by hand and marked unverified — which is most of why an account
 * served one model in practice. Somebody who has configured a small fast model or a second profile
 * has already told this host which models their account can serve.
 *
 * NOTHING IS LAUNCHED AND NOTHING IS INVENTED. This is the same single read of the same file, so it
 * cannot cost a provider request. The wire carries ONE `source` for the whole set, which stays
 * literally true because every candidate comes out of the one document that path names. WHICH key
 * named a given model is deliberately not published: saying so per candidate is a wire field and a
 * surface change rather than a read, and it is stated as a limit rather than half-built.
 */
const namedModels = (settings: Readonly<Record<string, unknown>>): readonly string[] => {
  const found: string[] = [];
  const add = (value: unknown): void => {
    const model = trimmedString(value);
    if (model !== undefined && !found.includes(model)) found.push(model);
  };

  add(settings[MODEL_KEY]);
  const environment = settings.env;
  if (isRecord(environment))
    for (const [name, value] of Object.entries(environment)) if (MODEL_ENV_NAME.test(name)) add(value);
  const profiles = settings[PROFILES_KEY];
  if (isRecord(profiles)) for (const profile of Object.values(profiles)) if (isRecord(profile)) add(profile[MODEL_KEY]);
  return found;
};

/** What one settings document turned out to name: at least one model, or the reason it named none. */
type DeclaredModels =
  | { readonly kind: 'named'; readonly ids: readonly [string, ...(readonly string[])] }
  | { readonly kind: 'none'; readonly why: string };

/** What being unable to find this harness's command breaks, said whether or not it is missing. */
const ABSENCE_IMPACT: Readonly<Record<HarnessKind, string>> = {
  claude:
    'A wrapper this fleet publishes for a Claude account runs `claude`. Without it on this host, the wrapper exists and no Claude session can start.',
  codex:
    'A wrapper this fleet publishes for a Codex account runs `codex`. Without it on this host, the wrapper exists and no Codex session can start.',
};

/**
 * The models the harness declares, or the reason nothing could be read out of its settings.
 *
 * A settings document that will not parse is reported as a REASON rather than swallowed. The harness
 * itself is failing to read that file too, so a person who is told "no model detected" and nothing
 * else has been sent looking in the wrong place.
 */
const declaredModels = (read: HarnessDocumentRead, layout: HarnessHomeLayout): DeclaredModels => {
  if (read.kind === 'absent') return { kind: 'none', why: `there is no ${layout.settingsPath} on this host` };
  if (read.kind === 'too-large')
    return { kind: 'none', why: `${layout.settingsPath} is ${String(read.bytes)} bytes and was not read` };
  if (read.kind === 'unreadable')
    return { kind: 'none', why: `${layout.settingsPath} could not be read (${read.reason})` };
  let settings: Readonly<Record<string, unknown>>;
  try {
    settings = parseSettings(read.text, layout.settingsFormat);
  } catch (error) {
    return {
      kind: 'none',
      why: `${layout.settingsPath} is not valid ${layout.settingsFormat} (${errorText(error)})`,
    };
  }
  const [first, ...rest] = namedModels(settings);
  if (first === undefined) return { kind: 'none', why: `${layout.settingsPath} names no model in ${MODEL_SOURCES}` };
  return { kind: 'named', ids: [first, ...rest] };
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const modelsFor = (read: HarnessDocumentRead, layout: HarnessHomeLayout): HarnessModels => {
  const declared = declaredModels(read, layout);
  // A DETECTION OF SEVERAL, not of one. The first is the default because `namedModels` puts the
  // harness's own `model` first, and the published shape demands the default be one of the ids.
  if (declared.kind === 'named')
    return {
      origin: 'detected',
      ids: [...declared.ids],
      defaultModel: declared.ids[0],
      source: layout.settingsPath,
    };
  const starter = FLEET_STARTER_MODELS[layout.kind];
  return {
    origin: 'fallback',
    ids: [starter],
    defaultModel: starter,
    // The reason travels WITH the fallback. "This is a fallback" on its own does not tell anybody
    // whether the harness is unconfigured or its configuration is broken.
    source: `Ferretry's starter model for ${layout.kind}, because ${declared.why}`,
  };
};

const instructionsFor = (
  read: HarnessDocumentRead,
  layout: HarnessHomeLayout,
  maxBytes: number,
): HarnessInstructions => {
  switch (read.kind) {
    case 'text':
      return { found: true, source: layout.instructionsPath, text: read.text, bytes: read.bytes };
    case 'absent':
      return {
        found: false,
        source: layout.instructionsPath,
        reason: `this host has no ${layout.instructionsName} there`,
      };
    case 'too-large':
      return {
        found: false,
        source: layout.instructionsPath,
        // The size and the ceiling, both, so the sentence is actionable rather than a refusal.
        reason: `that ${layout.instructionsName} is ${String(read.bytes)} bytes, over the ${String(maxBytes)}-byte ceiling one fleet asset may carry — importing it would silently drop the rest`,
      };
    default:
      return { found: false, source: layout.instructionsPath, reason: read.reason };
  }
};

/**
 * The whole report: every harness, installed or not.
 *
 * The two reads per harness are issued together, and the harnesses in parallel with each other. A
 * form open should not cost four sequential round trips to a disk for facts that do not depend on
 * one another.
 */
export async function readHarnessDiscovery(options: HarnessDiscoveryOptions): Promise<HarnessDiscoveryReport> {
  const harnesses = await Promise.all(
    options.layouts.map(async (layout): Promise<HarnessDiscovery> => {
      const [settings, instructions] = await Promise.all([
        options.documents.read(layout.settingsPath, options.maxDocumentBytes),
        options.documents.read(layout.instructionsPath, options.maxDocumentBytes),
      ]);
      const command = options.executables.resolve(layout.kind);
      return {
        kind: layout.kind,
        ...(command === undefined ? {} : { command }),
        absenceImpact: ABSENCE_IMPACT[layout.kind],
        models: modelsFor(settings, layout),
        instructions: instructionsFor(instructions, layout, options.maxDocumentBytes),
      };
    }),
  );
  return {
    harnesses,
    noneInstalled: harnesses.every(harness => harness.command === undefined),
    limitation:
      'Every answer here is a PATH lookup and a file read. It does not prove a harness is signed in, has credit, or can reach its provider, and a model read out of a settings file is what that file says rather than what the provider will serve. Where a settings file names several models, they are reported together against that one path — which key named which model is not said.',
  };
}
