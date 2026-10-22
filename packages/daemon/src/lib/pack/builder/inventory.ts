/**
 * WHAT THE GUIDE BUILDER IS SHOWN (docs/pack-mode.md § Suggesting a guide): every model every catalog in
 * effect lists — with the owner's description of it (else the catalog's), its tier, context window, efforts,
 * list price and retirement date — and, for each, every runtime here that runs it, whether that runtime can
 * start a ferret now (exactly as `fy recommend` decides) and how much quota its login has left; then every
 * agent runtime, the guide in effect and the owner's routing preferences.
 *
 * Names and states only: a login is named by its id, a refusal by its sentence, and nothing here can hold a
 * credential or a value — the facts it reads have none.
 *
 * Pure: catalogs, fleet facts and the guide in, the inventory out.
 */
import type {
  FleetRuntimeView,
  ModelCatalogEntryView,
  ModelCatalogView,
  ModelDescription,
  ModelsGuide,
  PackInventory,
  PackInventoryModel,
  PackInventoryRuntime,
  PackModelHeadroom,
  PackQuota,
} from '@ferretry/protocol';
import { fleetModels } from '../guide.ts';
import { QUOTA_RANK, quotaOf } from '../quota.ts';
import { type PackFleetFacts, runtimeRefusal } from '../recommend.ts';

/** Everything the inventory is built from. */
export interface InventoryInput {
  readonly catalogs: readonly ModelCatalogView[];
  readonly facts: PackFleetFacts;
  readonly guide: ModelsGuide;
  readonly described: readonly ModelDescription[];
  readonly preferences?: string | undefined;
  readonly now: string;
}

/** A runtime's login quota now. */
const quotaFor = (runtime: FleetRuntimeView, facts: PackFleetFacts, now: string): PackQuota =>
  quotaOf(
    facts.credentials.find(credential => credential.id === runtime.credential.id),
    now,
  );

/** Most headroom first: the band, then the share left, then the order given. */
const byHeadroom = <T extends { readonly quota: PackQuota }>(rows: readonly T[]): readonly T[] =>
  rows
    .map((row, index) => ({ row, index }))
    .toSorted(
      (left, right) =>
        QUOTA_RANK[left.row.quota.state] - QUOTA_RANK[right.row.quota.state] ||
        (right.row.quota.leftPercent ?? 100) - (left.row.quota.leftPercent ?? 100) ||
        left.index - right.index,
    )
    .map(({ row }) => row);

/** Every agent runtime here: what it is, whether it can start a ferret now, and its quota. */
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
      };
    });
}

/** The ready runtimes, the one with the most headroom first: where a builder ferret should run. */
export const readyByHeadroom = (runtimes: readonly PackInventoryRuntime[]): readonly PackInventoryRuntime[] =>
  byHeadroom(runtimes.filter(runtime => runtime.ready));

/** "3 runtimes, 2 ready; most headroom on claude-work: 5h 2% · wk 46%". */
function headroomOf(
  rows: readonly { readonly name: string; readonly ready: boolean; readonly quota: PackQuota }[],
): PackModelHeadroom {
  const ready = rows.filter(row => row.ready);
  const best = byHeadroom(ready)[0];
  const count = `${String(rows.length)} runtime${rows.length === 1 ? '' : 's'}`;
  const summary =
    rows.length === 0
      ? 'no runtime here runs it'
      : best === undefined
        ? `${count}, none ready`
        : `${count}, ${String(ready.length)} ready; most headroom on ${best.name}: ${best.quota.summary}`;
  return {
    runtimes: rows.length,
    ready: ready.length,
    ...(best === undefined ? {} : { best: { runtime: best.name, quota: best.quota } }),
    summary,
  };
}

/** A catalog's entry for one model of one CLI. */
const entryOf = (
  catalogs: readonly ModelCatalogView[],
  provider: string,
  harness: 'claude' | 'codex',
  id: string,
): ModelCatalogEntryView | undefined =>
  catalogs.find(catalog => catalog.id === provider)?.[harness]?.find(entry => entry.id === id);

/** The inventory: every model with its runtimes and headroom, every runtime, the guide and the preferences. */
export function buildInventory(input: InventoryInput): PackInventory {
  const runtimes = inventoryRuntimes(input.facts, input.now);
  const byName = new Map(input.facts.runtimes.map(runtime => [runtime.name, runtime]));
  const models = fleetModels(input.catalogs, input.facts.runtimes, input.described).map((model): PackInventoryModel => {
    const entry = entryOf(input.catalogs, model.provider, model.harness, model.id);
    const rows = model.runtimes.flatMap(name => {
      const runtime = byName.get(name);
      if (runtime === undefined) return [];
      const refusal = runtimeRefusal(runtime, model.id, input.facts);
      return [
        {
          name,
          ready: refusal === undefined,
          ...(refusal === undefined ? {} : { reason: refusal.message }),
          quota: quotaFor(runtime, input.facts, input.now),
        },
      ];
    });
    const { runtimes: _names, description, describedBy, ...rest } = model;
    return {
      ...rest,
      description: description ?? model.label,
      describedBy: describedBy ?? 'catalog',
      ...(entry?.retires === undefined ? {} : { retires: entry.retires }),
      ...(entry?.price === undefined ? {} : { price: entry.price }),
      runtimes: rows.map(({ quota: _quota, ...row }) => row),
      headroom: headroomOf(rows),
    };
  });
  const preferences = input.preferences?.trim();
  return {
    at: input.now,
    models,
    runtimes,
    guide: input.guide,
    ...(preferences === undefined || preferences === '' ? {} : { preferences }),
  };
}
