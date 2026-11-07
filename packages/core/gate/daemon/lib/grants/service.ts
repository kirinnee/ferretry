import type { CapabilityDemand } from '@ferretry/kernel/contract';
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import {
  CAPABILITIES,
  CAPABILITY_NAMES,
  type CapabilityGrant,
  CapabilityGrantSchema,
  type CapabilityGrants,
  type CapabilityName,
  CapabilityNameSchema,
  type CapabilityPresentation,
  GrantRefusalSchema,
} from '../../../contract/index.ts';
import { decideCapability, type GrantEvaluation, isGovernedCaller } from '../api/capability.ts';

/**
 * The daemon-wide grant surface, `/v1/grants` and its history (today's `lib/grants/service.ts` view/patch/history
 * and `protocol/src/lib/grants.ts` wire schemas, copied; lead decision: Gate declares `/v1/grants*`). The decision
 * itself is admission's (`decideCapability`); this reports it and changes the document (`gate.yaml` `grants`).
 *
 * The wire schemas live here, not in the frozen contract, because only Gate reads them today; the app's grants panel
 * will need them in the contract (reported to the lead).
 */

export const CapabilityGrantViewSchema = z.strictObject({
  capability: CapabilityNameSchema,
  use: z.boolean(),
  configure: z.boolean(),
  granted: CapabilityGrantSchema,
  deviceGranted: CapabilityGrantSchema.optional(),
  useRefusal: GrantRefusalSchema,
  configureRefusal: GrantRefusalSchema,
  mayGrant: z.boolean(),
  origin: z.enum(['default', 'config file']),
});
export type CapabilityGrantView = z.infer<typeof CapabilityGrantViewSchema>;

export const GrantsViewSchema = z.strictObject({
  capabilities: z.array(CapabilityGrantViewSchema).readonly(),
  governed: z.boolean(),
  hostLocal: z.boolean(),
  steppedUp: z.boolean(),
});
export type GrantsView = z.infer<typeof GrantsViewSchema>;

/** How many recorded changes one read returns, newest first (G160). */
export const GRANT_AUDIT_MAX_ENTRIES = 50 as const;
/** The bytes one read covers, newest first (G160). */
export const GRANT_AUDIT_MAX_BYTES = 64 * 1024;

export const GrantAuditEntrySchema = z.strictObject({
  at: InstantSchema,
  actor: z.string().min(1).max(256),
  changes: z.array(z.string().min(1).max(96)).readonly(),
});
export type GrantAuditEntry = z.infer<typeof GrantAuditEntrySchema>;

export const GrantAuditViewSchema = z.strictObject({
  entries: z.array(GrantAuditEntrySchema).readonly(),
  unreadable: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type GrantAuditView = z.infer<typeof GrantAuditViewSchema>;

export const GrantsPatchSchema = z
  .strictObject(
    Object.fromEntries(
      CAPABILITY_NAMES.map(name => [
        name,
        z.strictObject({ use: z.boolean().optional(), configure: z.boolean().optional() }).optional(),
      ]),
    ) as {
      readonly [K in CapabilityName]: z.ZodOptional<
        z.ZodObject<{ use: z.ZodOptional<z.ZodBoolean>; configure: z.ZodOptional<z.ZodBoolean> }>
      >;
    },
  )
  .refine(patch => Object.values(patch).some(value => value !== undefined), 'a grant patch must change something');
export type GrantsPatch = z.infer<typeof GrantsPatchSchema>;

/** A refusal the grant surface raises, in a taxonomy the route turns into a status (today's `GrantFailure`). */
export type GrantFailure = 'invalid' | 'forbidden' | 'device-not-granted' | 'step-up-required' | 'unavailable';

export class GrantError extends Error {
  constructor(
    readonly failure: GrantFailure,
    message: string,
  ) {
    super(message);
    this.name = 'GrantError';
  }
}

/** Applying a patch: an axis the patch does not name keeps its value (today's `applyGrantPatch`). */
export function applyGrantPatch(current: CapabilityGrants, patch: GrantsPatch): CapabilityGrants {
  const next: Record<CapabilityName, CapabilityGrant> = { ...current };
  for (const name of CAPABILITY_NAMES) {
    const change = patch[name];
    if (change === undefined) continue;
    next[name] = { use: change.use ?? current[name].use, configure: change.configure ?? current[name].configure };
  }
  return next;
}

/** Which axes a change turns ON (today's `widenedBy`). */
export function widenedBy(current: CapabilityGrants, next: CapabilityGrants): readonly string[] {
  const widened: string[] = [];
  for (const name of CAPABILITY_NAMES) {
    if (!current[name].use && next[name].use) widened.push(`${name}.use`);
    if (!current[name].configure && next[name].configure) widened.push(`${name}.configure`);
  }
  return widened;
}

/** Every axis a change moves, for the history (today's `grantChanges`). */
export function grantChanges(current: CapabilityGrants, next: CapabilityGrants): readonly string[] {
  const changes: string[] = [];
  for (const name of CAPABILITY_NAMES)
    for (const axis of ['use', 'configure'] as const)
      if (current[name][axis] !== next[name][axis]) changes.push(`${name}.${axis}=${next[name][axis] ? 'on' : 'off'}`);
  return changes;
}

export interface GrantDocumentPort {
  /** The daemon-wide half in effect, or `undefined` when undetermined. */
  read(): CapabilityGrants | undefined;
  /** Which capabilities `gate.yaml` actually names (the provenance column, per capability, G155). */
  written(): readonly CapabilityName[];
  write(next: CapabilityGrants): Promise<void>;
}

export interface GrantHistoryPort {
  record(entry: GrantAuditEntry): Promise<void>;
  recent(limit: number): Promise<GrantAuditView>;
}

export interface GrantServiceDeps {
  readonly document: GrantDocumentPort;
  readonly history: GrantHistoryPort;
  readonly clock: { readonly now: () => string };
  readonly clientName: string;
}

export class GrantService {
  constructor(private readonly deps: GrantServiceDeps) {}

  #evaluate(presentation: CapabilityPresentation): GrantEvaluation {
    const governed = isGovernedCaller(presentation);
    return {
      grants: this.deps.document.read(),
      governed,
      hostLocal: presentation.local,
      stepUp: presentation.stepUp,
      ...(governed && presentation.deviceGrants !== undefined ? { device: presentation.deviceGrants } : {}),
    };
  }

  /** What the UI is told, so it can explain a limit BEFORE somebody clicks (G9, G124, G151). */
  view(presentation: CapabilityPresentation): GrantsView {
    const evaluation = this.#evaluate(presentation);
    const written = this.deps.document.written();
    return {
      capabilities: CAPABILITY_NAMES.map(name => {
        const demand = (axis: 'use' | 'configure'): CapabilityDemand => ({ capability: CAPABILITIES[name], axis });
        const use = decideCapability(demand('use'), evaluation);
        const configure = decideCapability(demand('configure'), evaluation);
        return {
          capability: name,
          use: use.allowed,
          configure: configure.allowed,
          granted: evaluation.grants?.[name] ?? { use: false, configure: false },
          ...(evaluation.device === undefined || evaluation.device === null
            ? {}
            : { deviceGranted: evaluation.device[name] }),
          useRefusal: use.refusal,
          configureRefusal: configure.refusal,
          // LOCALITY decides it, and nothing else can: no caller off this host ever widens (G46).
          mayGrant: evaluation.hostLocal,
          origin: written.includes(name) ? 'config file' : 'default',
        };
      }),
      governed: evaluation.governed,
      hostLocal: evaluation.hostLocal,
      steppedUp: evaluation.stepUp,
    };
  }

  /**
   * A change to the daemon-wide grants (today's `patch`, in order). WIDENING IS A LOCAL ACT: no remote caller may
   * turn a capability on, with or without a step-up (G46, G121). The patch is all or nothing (G123), refused before
   * anything is written. A governed caller must hold `configure` on every capability it names, both halves, and a
   * live step-up (G122).
   */
  async patch(patch: GrantsPatch, presentation: CapabilityPresentation): Promise<GrantsView> {
    const current = this.deps.document.read();
    if (current === undefined)
      throw new GrantError(
        'unavailable',
        'this daemon could not read its capability grants, so it will not change them',
      );
    const evaluation = this.#evaluate(presentation);
    const next = applyGrantPatch(current, patch);
    const widened = widenedBy(current, next);
    if (widened.length > 0 && !evaluation.hostLocal)
      throw new GrantError(
        'forbidden',
        `${widened.join(', ')} can only be turned on from the machine itself — no remote caller may. Run \`${this.deps.clientName} daemon config set ${widened[0]?.split('.')[0] ?? 'fleet'} --${widened[0]?.split('.')[1] ?? 'use'}\` on the host.`,
      );
    if (evaluation.governed) {
      if (evaluation.device === null)
        throw new GrantError('forbidden', 'this device is no longer paired, so it cannot change the grants');
      for (const name of CAPABILITY_NAMES) {
        if (patch[name] === undefined) continue;
        const grant = current[name];
        if (!grant.use || !grant.configure)
          throw new GrantError(
            'forbidden',
            `the operator of this machine has not granted the UI permission to change the ${name} grant`,
          );
        const own = evaluation.device?.[name];
        if (own !== undefined && (!own.use || !own.configure))
          throw new GrantError(
            'device-not-granted',
            `this device has not been given ${name}, so it cannot change the ${name} grant for the machine`,
          );
      }
      if (!evaluation.stepUp)
        throw new GrantError(
          'step-up-required',
          'changing these grants needs a passkey confirmation from this device.',
        );
    }
    const changes = grantChanges(current, next);
    await this.deps.document.write(next);
    // AFTER the write, so a record can never claim a change that did not reach the document.
    if (changes.length > 0)
      await this.deps.history.record({
        at: this.deps.clock.now() as GrantAuditEntry['at'],
        actor: presentation.actor,
        changes,
      });
    return this.view({ ...presentation });
  }

  async history(limit: number): Promise<GrantAuditView> {
    return await this.deps.history.recent(limit);
  }
}
