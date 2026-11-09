/**
 * @ferretry/plugin-runtimes/contract/testing — the fake and the conformance suite (§7.8). The real implementation and
 * the fake pass the same suite.
 */
import { err, ok, type Result } from '@ferretry/std';
import {
  AccountChangeRequestSchema,
  ApplyOutcomeSchema,
  type CatalogInstallChange,
  ProposalApplyRequestSchema,
  type ResolveResult,
  type RuntimeId,
  RuntimeIdSchema,
  type RuntimesApi,
  type RuntimeSummary,
  RuntimeSummarySchema,
} from '../index.ts';

export interface FakeRuntimes extends RuntimesApi {
  setRuntimes(runtimes: readonly RuntimeSummary[], defaultRuntime?: RuntimeId): void;
  readonly installed: readonly CatalogInstallChange[];
}

/** An in-memory Runtimes: the machine's runtimes are whatever the test set. */
export function fakeRuntimes(): FakeRuntimes {
  let runtimes: readonly RuntimeSummary[] = [];
  let defaultRuntime: RuntimeId | undefined;
  const installed: CatalogInstallChange[] = [];
  const get = async (id: RuntimeId): Promise<RuntimeSummary | undefined> => runtimes.find(runtime => runtime.id === id);
  return {
    list: async () => runtimes,
    get,
    default: async () => defaultRuntime,
    resolve: async (id): Promise<ResolveResult> => {
      const wanted = id ?? defaultRuntime;
      const found = wanted === undefined ? undefined : await get(wanted);
      if (found === undefined) return { ok: false, refusal: 'unknown', sentence: 'There is no such runtime.' };
      if (found.disabled !== undefined)
        return { ok: false, refusal: 'disabled', sentence: `${found.id} is switched off.` };
      if (!found.launch.available) return { ok: false, refusal: 'not_signed_in', sentence: found.launch.reason };
      return { ok: true, runtime: found };
    },
    // No fleet is published in memory: there are no homes, and so no reader.
    homes: async () => [],
    home: () => undefined,
    installCatalogItem: async change => {
      installed.push(change);
      return {
        outcome: 'committed',
        result: { accountCount: 0, operationCount: 0, manifestPath: '/fake', prunedWrappers: [], sharedHistory: [] },
      };
    },
    setRuntimes: (next, nextDefault) => {
      runtimes = next;
      defaultRuntime = nextDefault;
    },
    get installed() {
      return installed;
    },
  };
}

/** What every implementation of `RuntimesApi` must satisfy. Failures come back as sentences so any runner can report them. */
export async function runtimesConformance(make: () => RuntimesApi): Promise<Result<true, readonly string[]>> {
  const failures: string[] = [];
  const api = make();
  for (const runtime of await api.list()) {
    if (!RuntimeSummarySchema.safeParse(runtime).success) failures.push(`list() returns summaries (${runtime.id})`);
  }
  const unknown = await api.resolve(RuntimeIdSchema.parse('no-such-runtime'));
  if (unknown.ok) failures.push('resolve() refuses an unknown runtime');
  else if (unknown.refusal !== 'unknown') failures.push('resolve() names an unknown runtime "unknown"');
  const chosen = await api.default();
  if (chosen !== undefined && (await api.get(chosen)) === undefined)
    failures.push('default() names a runtime that exists');
  // A change names one intent and never carries a configuration document.
  if (AccountChangeRequestSchema.safeParse({ change: { kind: 'runtime.remove', name: 'x', document: {} } }).success)
    failures.push('a change is strict: it carries no document');
  // An apply has an EMPTY body: a step-up is the confirmation.
  if (ProposalApplyRequestSchema.safeParse({ approval: 'x' }).success) failures.push('an apply body is empty');
  if (ApplyOutcomeSchema.safeParse({ outcome: 'committed' }).success) failures.push('an outcome carries its result');
  return failures.length === 0 ? ok(true) : err(failures);
}
