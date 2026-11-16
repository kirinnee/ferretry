import { z } from 'zod';
import { HarnessSchema } from './session-base.ts';

/**
 * Changing what a RUNNING ferret is running, and reading what it may be changed to: the shapes the Ferrets port's
 * `runtimeControl` member speaks (`contract/ports/runtime-control.port.ts`) and a harness's `runtimeSwitch` reads.
 * They live in the contract, not in a daemon folder, because Runtimes, the harness plugins and Ferrets all name them.
 */

export const RuntimeModelOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
});

export const RuntimeReasoningChoiceSchema = z.object({
  value: z.string().min(1),
  description: z.string().optional(),
});

export const RuntimeModelChoiceSchema = RuntimeModelOptionSchema.extend({
  description: z.string().optional(),
  /** Where the login's model catalog puts it (docs/model-catalog.md): a picker groups by it. */
  tier: z.enum(['best', 'balanced', 'fast']).optional(),
  /** The context window, in tokens, when the catalog says. */
  context: z.number().int().positive().optional(),
  isDefault: z.literal(true).optional(),
  reasoningEfforts: z.array(RuntimeReasoningChoiceSchema),
  defaultReasoningEffort: z.string().min(1).optional(),
  /**
   * Whether the harness offers FAST MODE on this model: `true` it does, `false` it does not, absent
   * the daemon cannot say (a daemon that predates fast mode, or a catalog that does not describe it).
   * A surface disables its fast toggle only on an explicit `false`.
   */
  fast: z.boolean().optional(),
  /** The model runs in fast mode unless told otherwise (Codex: its default service tier is the fast one). */
  fastDefault: z.literal(true).optional(),
});
export type RuntimeModelChoice = z.infer<typeof RuntimeModelChoiceSchema>;

export const RuntimeModelCatalogSchema = z.object({
  harness: HarnessSchema,
  source: z.enum(['wrapper-inventory', 'codex-app-server']),
  choices: z.array(RuntimeModelChoiceSchema),
  /**
   * The login's model catalog, when it reads one. With it, each choice's `reasoningEfforts` is what that
   * model takes — empty means none — and `customIds` says the session may be switched to any id.
   */
  catalog: z.object({ id: z.string().min(1), label: z.string().min(1), customIds: z.boolean() }).optional(),
});
export type RuntimeModelCatalog = z.infer<typeof RuntimeModelCatalogSchema>;

export const RuntimeControlRequestSchema = z.discriminatedUnion('action', [
  // Codex's native picker can be opened without selecting a target. It is a
  // real control operation, but deliberately makes no claim about the eventual
  // model; targeted callers supply both opaque values unchanged.
  z.strictObject({
    action: z.literal('model'),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
  }),
  z.strictObject({ action: z.literal('effort'), effort: z.string().min(1) }),
  // Fast mode is a switch, not a level: `true` turns it on and `false` off, and either is applied
  // with the harness's own command at an idle prompt and confirmed by what the harness then reports.
  z.strictObject({ action: z.literal('fast'), fast: z.boolean() }),
  z.strictObject({ action: z.literal('compact') }),
]);
export type RuntimeControlRequest = z.infer<typeof RuntimeControlRequestSchema>;

/**
 * Why a runtime read or control could not be served, CLOSED. The refusal is a domain fact (true whichever transport
 * asked); which HTTP status each one answers with belongs to the route that mounts it (Runtimes).
 */
export type RuntimeControlFailure =
  | 'invalid'
  | 'not_found'
  | 'refused'
  | 'unsupported'
  | 'catalog_unavailable'
  | 'conflict'
  | 'unsettled'
  | 'failed';

/** A refusal raised by {@link RuntimeControlApi}, in a taxonomy the mount can map to its transport. */
export class RuntimeControlError extends Error {
  constructor(
    readonly failure: RuntimeControlFailure,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeControlError';
  }
}
