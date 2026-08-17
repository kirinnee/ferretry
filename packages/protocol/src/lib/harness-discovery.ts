/**
 * What this host can be asked about a harness WITHOUT launching it, so a form can fill itself in.
 *
 * Every field here answers one question a person was previously made to answer by typing: which
 * harness is installed, what model it is configured to use, and what instructions document it
 * already reads. The daemon can see all three; before this contract existed it simply never said so.
 *
 * TWO RULES SHAPE EVERY SHAPE BELOW.
 *
 *  1. **A value carries where it came from, or it is not sent.** `detected` names the file it was
 *     read out of; `fallback` says out loud that the harness reported nothing and this is Ferretry's
 *     own starter value. There is no third case that looks like a detection and is not one, because
 *     a prefilled field that turns out to be a guess is worse than an empty one — an account that
 *     claims to serve a model it cannot is a session that fails at start.
 *  2. **An absence is a stated absence.** A harness that is not on `PATH` carries no `command` and a
 *     reason; a document that could not be read says which path and why. Nothing here is ever
 *     silently empty, because "we did not look" and "there is nothing there" send a reader to two
 *     different places.
 *
 * WHAT IT DELIBERATELY DOES NOT ESTABLISH, exactly as the boot preflight does not: a command on
 * `PATH` is not a harness that is signed in, in credit, or able to reach its provider. The report
 * carries that limit as text so no surface has to remember to say it.
 */

import { z } from 'zod';

/**
 * A model the harness itself is configured to use, with the file that says so.
 *
 * `fallback` is NOT a detection dressed up as one. It is Ferretry's own starter model for that
 * harness — the same value `fy fleet init --first-account` writes — offered because an empty model
 * box blocks the form entirely, and labelled so nobody mistakes it for something the host reported.
 */
export const HarnessModelOriginSchema = z.enum(['detected', 'fallback']);
export type HarnessModelOrigin = z.infer<typeof HarnessModelOriginSchema>;

export const HarnessModelsSchema = z.strictObject({
  origin: HarnessModelOriginSchema,
  /** Model identifiers, most-preferred first. Never empty: a report with nothing to offer says so. */
  ids: z.array(z.string().min(1)).min(1),
  /** The default among `ids`, always one of them. */
  defaultModel: z.string().min(1),
  /**
   * Where this came from, in words a person can check: an absolute path for a detection, or the
   * sentence naming the fallback for what it is.
   */
  source: z.string().min(1),
});
export type HarnessModels = z.infer<typeof HarnessModelsSchema>;

/**
 * The instructions document this host already has for this harness.
 *
 * The text travels with the report because the whole point is to OFFER it: the person sees what
 * would be written, edits it if they want to, and nothing is written until the ordinary review and
 * authorize step runs. A document too large to be a fleet asset is reported as absent WITH its size
 * rather than silently truncated — importing half of somebody's instructions is the failure mode
 * that would be hardest to notice.
 */
export const HarnessInstructionsSchema = z.discriminatedUnion('found', [
  z.strictObject({
    found: z.literal(true),
    /** The absolute path the text was read from, shown so the offer is checkable. */
    source: z.string().min(1),
    text: z.string(),
    bytes: z.number().int().nonnegative(),
  }),
  z.strictObject({
    found: z.literal(false),
    /** Where it was looked for. Named even when nothing was there, so "not found" is checkable. */
    source: z.string().min(1),
    reason: z.string().min(1),
  }),
]);
export type HarnessInstructions = z.infer<typeof HarnessInstructionsSchema>;

/** One harness, as this host can be inspected. */
export const HarnessDiscoverySchema = z.strictObject({
  kind: z.enum(['claude', 'codex']),
  /**
   * The absolute program this harness's own bare command resolves to on this host's `PATH`, or
   * absent when it resolves to nothing.
   *
   * It is the SAME lookup the boot preflight performs — the resolved path was always there and was
   * being thrown away for a boolean. Absent means the harness is not installed here, which is the
   * one state where telling a person plainly matters most: the form would otherwise happily
   * configure an account for a harness no session on this host could ever launch.
   */
  command: z.string().min(1).optional(),
  /** What being unable to find that command breaks, said whether or not it is missing. */
  absenceImpact: z.string().min(1),
  models: HarnessModelsSchema,
  instructions: HarnessInstructionsSchema,
});
export type HarnessDiscovery = z.infer<typeof HarnessDiscoverySchema>;

/**
 * Every harness, reported whether or not this host has it.
 *
 * EVERY KIND IS PRESENT, for the same reason the boot preflight lists them all: a report that named
 * only what it found could not answer "is Codex set up here?", which is the question being asked.
 */
export const HarnessDiscoveryReportSchema = z.strictObject({
  harnesses: z.array(HarnessDiscoverySchema).min(1),
  /** True when no harness command resolved at all — the state a person most needs told. */
  noneInstalled: z.boolean(),
  /** The limit of this evidence, carried so a surface cannot forget to say it. */
  limitation: z.string().min(1),
});
export type HarnessDiscoveryReport = z.infer<typeof HarnessDiscoveryReportSchema>;
