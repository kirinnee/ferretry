/**
 * What the harnesses themselves give a materialisation: where each one lives on this host, and what each one's own plugin
 * hands Runtimes (`RuntimesHarnessKit`). Both are read live with every plan, for every harness Runtimes can run.
 */
import type { RuntimesHarnessKit } from '../../../contract/index.ts';
import type { MaterialiseInput } from '../account/materialise.ts';
import { supportedKinds } from '../harness-kind.ts';
import type { HarnessKind } from '../manifest.ts';

interface HarnessFactsDeps {
  /** The harness command this daemon's one rule resolves. */
  locate(harness: HarnessKind): string | undefined;
  /** What each harness's own plugin hands Runtimes. Absent: no plugin gives any. */
  kits?(): ReadonlyMap<HarnessKind, RuntimesHarnessKit>;
}

/** The absolute path each located harness resolved to, which a wrapper execs instead of a bare name. */
function harnessCommandsOf(locate: (harness: HarnessKind) => string | undefined): Partial<Record<HarnessKind, string>> {
  return Object.fromEntries(
    supportedKinds().flatMap(kind => {
      const command = locate(kind);
      return command === undefined ? [] : [[kind, command] as const];
    }),
  );
}

/** The `harnessCommands` and `kits` of a materialisation. */
export function harnessFactsOf(deps: HarnessFactsDeps): Pick<MaterialiseInput, 'harnessCommands' | 'kits'> {
  return {
    harnessCommands: harnessCommandsOf(harness => deps.locate(harness)),
    ...(deps.kits === undefined ? {} : { kits: deps.kits() }),
  };
}
