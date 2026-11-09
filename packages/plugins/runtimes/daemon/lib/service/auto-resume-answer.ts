/**
 * Runtimes' answer to Ferrets' `auto-resume.decide` (W2-a, RULING #27 Q5): whether an automatic resume after a host
 * restart may spend. Ferrets resumes only on THIS plugin's own yes, so every doubt here is a no:
 *
 * - `switch`: the machine's "Auto-resume after restart" (`runtimes.yaml` `autoResume`). Yes only when it is read and
 *   on, and it is read again for EVERY ferret's `runtime` question too (Ferrets asks `switch` once per pass). While the
 *   switch cannot be read the answer is no: an owner who turned it off must never be resumed against it, and nothing
 *   unattended is spent on a guess.
 * - `runtime`: the runtime the ferret ran on can serve a launch now (today's `resolveStartAccount`): `resolve` says ok.
 *
 * Pure apart from the seams it is handed.
 */
import { AutoResumeDecideInputSchema } from '@ferretry/core-ferrets/contract';
import type { HookDecision } from '@ferretry/kernel/contract';
import { RuntimeIdSchema, type RuntimesApi } from '../../../contract/index.ts';

/** Why nothing is resumed while the machine's switch cannot be read. */
export const AUTO_RESUME_SWITCH_UNREAD =
  "this version of Ferretry cannot read the machine's Auto-resume after restart switch yet, so nothing is resumed";

export interface AutoResumeAnswerDeps {
  /** The machine's switch: `true` on, `false` off, `undefined` when it cannot be read. */
  readonly switchOn: () => boolean | undefined;
  readonly resolve: RuntimesApi['resolve'];
}

export function autoResumeAnswer(deps: AutoResumeAnswerDeps): (input: unknown) => Promise<HookDecision> {
  return async input => {
    const parsed = AutoResumeDecideInputSchema.safeParse(input);
    if (!parsed.success) return { allow: false, reason: 'the auto-resume question is not one Runtimes can answer' };
    // The switch is read on EVERY question, the per-ferret one included: Ferrets asks `switch` once per pass, so an
    // owner who turns it off mid-pass must stop the resumes that have not happened yet (spend).
    const on = deps.switchOn();
    if (on !== true)
      return {
        allow: false,
        reason: on === false ? 'Auto-resume after restart is off on this machine' : AUTO_RESUME_SWITCH_UNREAD,
      };
    if (parsed.data.ask === 'switch') return { allow: true };
    const runtime = RuntimeIdSchema.safeParse(parsed.data.runtime);
    if (!runtime.success) return { allow: false, reason: 'its record names no runtime this machine can have' };
    const resolved = await deps.resolve(runtime.data);
    return resolved.ok ? { allow: true } : { allow: false, reason: resolved.sentence };
  };
}

/**
 * The "Auto-resume after restart" switch as `runtimes.yaml` says it: left out (or no file at all) is ON, as today. A file
 * that cannot be read as it stands (unreadable, a link, too large, broken) says nothing (`undefined`), which the answer
 * reads as no, even when an older good version is still in effect: nothing unattended is spent on a guess.
 */
export function autoResumeSwitch(
  state: 'absent' | 'valid' | 'invalid' | 'held',
  file: { readonly autoResume?: boolean } | undefined,
): boolean | undefined {
  if (state === 'absent') return true;
  if (state === 'invalid') return undefined;
  return file === undefined ? undefined : (file.autoResume ?? true);
}

/**
 * The switch the answer reads: the host assembly's own answer when it has one, VERBATIM (an answer of `undefined` is
 * "cannot be read" and must stay a no, never fall through to the file); the file's switch only when the assembly has none.
 */
export function readAutoResume(
  assembly: (() => boolean | undefined) | undefined,
  file: () => boolean | undefined,
): boolean | undefined {
  return assembly === undefined ? file() : assembly();
}
