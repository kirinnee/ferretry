/**
 * The one sentence an import ends with, in words a person reads: which runtimes it made, named the way every screen names a
 * runtime (`runtimeDisplayName`), never by the stored name (`claude-default`).
 */
import { type RuntimeNameSource, runtimeDisplayName } from '../../../contract/index.ts';
import type { ImportPlan } from '../account/import.ts';
import type { AccountModel } from '../account/schema.ts';
import { harnessKey } from './foreign.ts';

/** A folder file an import left out, by the path it would have had, with why. */
export interface LeftOut {
  readonly path: string;
  readonly reason: string;
}

/** The most left-out files one sentence names; the rest are counted. */
const MAX_LEFT_OUT_NAMED = 20;

/** One folder's files into `assets` (under `prefix`); what the read skipped is handed back, so a partial import never reads as whole. */
export function takeFolder(
  folder: { readonly files: readonly { path: string; content: string }[]; readonly skipped: readonly LeftOut[] },
  prefix: string,
  assets: { path: string; content: string }[],
): LeftOut[] {
  for (const entry of folder.files) assets.push({ path: `${prefix}/${entry.path}`, content: entry.content });
  return folder.skipped.map(entry => ({ path: `${prefix}/${entry.path}`, reason: entry.reason }));
}

/** `Not imported: a (why), b (why), and N more.` as one sentence, or none when nothing was left out. */
export function notImported(left: readonly LeftOut[]): string[] {
  if (left.length === 0) return [];
  const named = left.slice(0, MAX_LEFT_OUT_NAMED).map(entry => `${entry.path} (${entry.reason})`);
  const more = left.length - named.length;
  return [`Not imported: ${named.join(', ')}${more > 0 ? `, and ${String(more)} more` : ''}.`];
}

/** `1 runtime created on QA Box: Claude · your terminal sign-in.`, or what was imported when it made none; then what was left out. */
export function importSummary(
  machine: string,
  plan: ImportPlan,
  existing: AccountModel,
  left: readonly LeftOut[] = [],
): string {
  return [importedWords(machine, plan, existing), ...notImported(left)].join(' ');
}

function importedWords(machine: string, plan: ImportPlan, existing: AccountModel): string {
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
            ...(runtime.namedByOwner === undefined ? {} : { namedByOwner: true as const }),
          },
        ];
  });
  if (sources.length === 0) return `Imported into ${machine}.`;
  const words = sources.map(source => runtimeDisplayName(source, sources)).toSorted();
  return `${String(sources.length)} ${sources.length === 1 ? 'runtime' : 'runtimes'} created on ${machine}: ${words.join(', ')}.`;
}
