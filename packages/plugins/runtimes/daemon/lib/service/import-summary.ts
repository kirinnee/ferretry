/**
 * The one sentence an import ends with, in words a person reads: which runtimes it made, named the way every screen names a
 * runtime (`runtimeDisplayName`), never by the stored name (`claude-default`).
 */
import { type RuntimeNameSource, runtimeDisplayName } from '../../../contract/index.ts';
import type { ImportPlan } from '../account/import.ts';
import type { AccountModel } from '../account/schema.ts';
import { harnessKey } from './foreign.ts';

/** `1 runtime created on QA Box: Claude · your terminal sign-in.`, or what was imported when it made none. */
export function importSummary(machine: string, plan: ImportPlan, existing: AccountModel): string {
  const sources = Object.entries(plan.runtimes).flatMap(([name, runtime]): RuntimeNameSource[] => {
    const credential = plan.credentials[runtime.credential] ?? existing.credentials[runtime.credential];
    return credential === undefined
      ? []
      : [
          {
            name,
            harness: harnessKey(credential.harness),
            credential: { id: runtime.credential, store: credential.store, label: credential.label },
            profile: runtime.profile,
          },
        ];
  });
  if (sources.length === 0) return `Imported into ${machine}.`;
  const words = sources.map(source => runtimeDisplayName(source, sources)).toSorted();
  return `${String(sources.length)} ${sources.length === 1 ? 'runtime' : 'runtimes'} created on ${machine}: ${words.join(', ')}.`;
}
