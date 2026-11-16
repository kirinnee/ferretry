import { z } from 'zod';
import { type LoginsCommandDeps, LoginsCommandError } from './ports.ts';

/** Gate's grants read (a core route every caller may make): whether this caller may change the machine. */
export const GRANTS_ROUTE = 'GET /v1/grants' as const;

const REFUSAL_WORDS = ['granted', 'not-granted', 'device-not-granted', 'step-up-required', 'undetermined'] as const;
export type ApplyRefusal = (typeof REFUSAL_WORDS)[number];

/** The `fleet` capability's `configure` axis: the part of Gate's grants view this decides on. */
const GrantsReadSchema = z.object({
  capabilities: z.array(
    z.object({ capability: z.string(), configure: z.boolean(), configureRefusal: z.enum(REFUSAL_WORDS) }),
  ),
});

/** What this caller may do to the machine, as the operator's grants decided it. */
export interface ChangeAuthority {
  readonly mayApply: boolean;
  readonly applyRefusal: ApplyRefusal;
}

/** The authority a grants answer gives. A missing `fleet` row is the stricter reading, never "allowed". */
export function authorityOf(answer: unknown): ChangeAuthority {
  const read = GrantsReadSchema.safeParse(answer);
  const fleet = read.success ? read.data.capabilities.find(row => row.capability === 'fleet') : undefined;
  if (fleet === undefined) return { mayApply: false, applyRefusal: 'undetermined' };
  return { mayApply: fleet.configure, applyRefusal: fleet.configureRefusal };
}

/** Why this caller may not change the machine at all, in words, per shared grant refusal. */
export const REFUSALS: Record<ApplyRefusal, string> = {
  'not-granted': "This caller is not allowed to change this machine's setup: the operator has not granted it.",
  'device-not-granted':
    "This device has not been given permission to change this machine's setup. Grant it at the machine with `device grant`, or from a device that holds it.",
  'step-up-required':
    'This change needs a passkey confirmation from a paired device, which a command line cannot give. Make it from the app, or run this on the machine itself.',
  undetermined: "This machine's grant settings could not be read, so no change is allowed until they are fixed.",
  granted: "This caller is not allowed to change this machine's setup.",
};

/**
 * Refuse in words, before anything starts, when this caller may not change the machine.
 *
 * A caller ON this machine is ungoverned and always passes. There is nothing to carry afterwards: no unlock, no
 * password and no per-change confirmation exist, so the daemon's answer here is the whole of what a write needs to
 * know up front. The daemon still governs every route behind it.
 */
export async function requireMayApply(deps: Pick<LoginsCommandDeps, 'gateway'>): Promise<void> {
  const authority = await deps.gateway.authority();
  if (!authority.mayApply) throw new LoginsCommandError(REFUSALS[authority.applyRefusal]);
}
