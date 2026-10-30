/**
 * WHAT THE CLEAN-UP FERRET IS SHOWN (docs/pack-mode.md § Clean up): this machine's harness config as names and
 * states — every agent runtime with its CLI, the catalog its login reads, the models it offers, whether it can
 * start a ferret now (exactly as `fy recommend` decides) and how much quota its login has left; every model any
 * catalog lists with the runtimes here that run it; and the routing prompt in effect.
 *
 * Names and states only: a login is named by its id, a refusal by its sentence, and nothing here can hold a
 * credential or a value — the facts it reads have none.
 *
 * Pure: fleet facts, the vocabulary and the prompt in, the inventory out.
 */
import type {
  FleetRuntimeView,
  PackFleetModel,
  PackInventory,
  PackInventoryRuntime,
  PackQuota,
  RoutingPromptView,
} from '@ferretry/protocol';
import { QUOTA_RANK, quotaOf } from '../quota.ts';
import { type PackFleetFacts, runtimeRefusal } from '../recommend.ts';

/** Everything the inventory is built from. */
export interface InventoryInput {
  readonly facts: PackFleetFacts;
  readonly models: readonly PackFleetModel[];
  readonly routing: RoutingPromptView;
  readonly now: string;
}

/** A runtime's login quota now. */
const quotaFor = (runtime: FleetRuntimeView, facts: PackFleetFacts, now: string): PackQuota =>
  quotaOf(
    facts.credentials.find(credential => credential.id === runtime.credential.id),
    now,
    facts.paneLimits?.get(runtime.credential.id),
  );

/** The model ids a runtime offers: its catalog's, else its model set's available ones. */
const offered = (runtime: FleetRuntimeView): readonly string[] =>
  runtime.models !== undefined
    ? runtime.models.choices.map(choice => choice.id)
    : runtime.modelSet.source === 'model-set'
      ? runtime.modelSet.models.filter(entry => entry.available).map(entry => entry.id)
      : [];

/** Every agent runtime here: what it is, what it offers, whether it can start a ferret now, and its quota. */
export function inventoryRuntimes(facts: PackFleetFacts, now: string): readonly PackInventoryRuntime[] {
  return facts.runtimes
    .filter(runtime => runtime.agent)
    .map(runtime => {
      const refusal = runtimeRefusal(runtime, undefined, facts);
      return {
        name: runtime.name,
        harness: runtime.harness,
        ...(runtime.models === undefined ? {} : { provider: runtime.models.catalog.id }),
        login: runtime.credential.id,
        ready: refusal === undefined,
        ...(refusal === undefined ? {} : { refusal }),
        quota: quotaFor(runtime, facts, now),
        models: offered(runtime),
      };
    });
}

/** The ready runtimes, the one with the most headroom first: where a clean-up ferret should run. */
export const readyByHeadroom = (runtimes: readonly PackInventoryRuntime[]): readonly PackInventoryRuntime[] =>
  runtimes
    .map((runtime, index) => ({ runtime, index }))
    .filter(({ runtime }) => runtime.ready)
    .toSorted(
      (left, right) =>
        QUOTA_RANK[left.runtime.quota.state] - QUOTA_RANK[right.runtime.quota.state] ||
        (right.runtime.quota.leftPercent ?? 100) - (left.runtime.quota.leftPercent ?? 100) ||
        left.index - right.index,
    )
    .map(({ runtime }) => runtime);

/** The inventory: every runtime, every model with the runtimes here that run it, and the prompt in effect. */
export function buildInventory(input: InventoryInput): PackInventory {
  const runtimes = inventoryRuntimes(input.facts, input.now);
  const ready = new Map(runtimes.map(runtime => [runtime.name, runtime.ready]));
  return {
    at: input.now,
    runtimes,
    models: input.models.map(model => ({
      provider: model.provider,
      harness: model.harness,
      id: model.id,
      label: model.label,
      tier: model.tier,
      ...(model.context === undefined ? {} : { context: model.context }),
      efforts: [...model.efforts],
      runtimes: model.runtimes.map(name => ({ name, ready: ready.get(name) ?? false })),
    })),
    routing: input.routing,
  };
}
