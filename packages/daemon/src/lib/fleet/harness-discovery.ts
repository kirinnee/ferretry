/**
 * What this host already knows about a harness, so the account form does not ask a person for it.
 *
 * THE DETECTION IS NOT NEW. `readHarnessPreflight` has resolved `claude` and `codex` against this
 * host's `PATH` since the first boot milestone, and said so in the startup warning; what it never did
 * was OFFER that answer to anything a person types into. This module surfaces the same lookup, from
 * the same port, and adds the two further facts a form needs and a preflight has no use for: the model
 * the harness itself is configured with, and the instructions document it already reads.
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

/** What being unable to find this harness's command breaks, said whether or not it is missing. */
const ABSENCE_IMPACT: Readonly<Record<HarnessKind, string>> = {
  claude:
    'A wrapper this fleet publishes for a Claude account runs `claude`. Without it on this host, the wrapper exists and no Claude session can start.',
  codex:
    'A wrapper this fleet publishes for a Codex account runs `codex`. Without it on this host, the wrapper exists and no Codex session can start.',
};

/**
 * The model the harness declares, or the reason nothing could be read out of its settings.
 *
 * A settings document that will not parse is reported as a REASON rather than swallowed. The harness
 * itself is failing to read that file too, so a person who is told "no model detected" and nothing
 * else has been sent looking in the wrong place.
 */
const declaredModel = (read: HarnessDocumentRead, layout: HarnessHomeLayout): string | { readonly why: string } => {
  if (read.kind === 'absent') return { why: `there is no ${layout.settingsPath} on this host` };
  if (read.kind === 'too-large')
    return { why: `${layout.settingsPath} is ${String(read.bytes)} bytes and was not read` };
  if (read.kind === 'unreadable') return { why: `${layout.settingsPath} could not be read (${read.reason})` };
  let settings: Readonly<Record<string, unknown>>;
  try {
    settings = parseSettings(read.text, layout.settingsFormat);
  } catch (error) {
    return { why: `${layout.settingsPath} is not valid ${layout.settingsFormat} (${errorText(error)})` };
  }
  const declared = settings[MODEL_KEY];
  if (typeof declared !== 'string' || declared.trim() === '')
    return { why: `${layout.settingsPath} declares no "${MODEL_KEY}"` };
  return declared.trim();
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const modelsFor = (read: HarnessDocumentRead, layout: HarnessHomeLayout): HarnessModels => {
  const declared = declaredModel(read, layout);
  if (typeof declared === 'string')
    return { origin: 'detected', ids: [declared], defaultModel: declared, source: layout.settingsPath };
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
      'Every answer here is a PATH lookup and a file read. It does not prove a harness is signed in, has credit, or can reach its provider, and a model read out of a settings file is what that file says rather than what the provider will serve.',
  };
}
