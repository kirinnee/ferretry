/**
 * The kernel's test host around Runtimes' daemon half, with the services stubbed: what the routes own is the HTTP
 * shape (which status a refusal becomes, that every answer is parsed through the contract's schema and never cached,
 * that the caller's standing is handed on rather than decided here).
 *
 * The admission is Gate's stand-in (`StandInAdmission`), which reads the manifest's descriptors in today's boundary
 * order; it is not Gate, and these tests prove none of Gate's guarantees.
 */
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import type { CallStanding } from '@ferretry/kernel/contract';
import { StandInAdmission, ownerStanding } from '@ferretry/core-gate/contract/testing';
import type { DaemonImplementation } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { type RuntimesAssembly, runtimesDaemon } from '../../../daemon/index.ts';

/** A proposal id as the wire spells one. */
export const PROPOSAL_ID = 'fy_fprop_abcdefghijklmnopqrstuv';

export interface Hosted {
  readonly host: TestHost;
  /** Who is calling, from now on. Starts as the owner at the machine. */
  as(standing: CallStanding): void;
  readonly ferrets: FakeFerrets;
}

/** The daemon half over an assembly of stubs. `config` seeds `config/**` by file or collection. */
export async function hostRuntimes(
  assembly: RuntimesAssembly,
  options: { readonly config?: Readonly<Record<string, unknown>> } = {},
): Promise<Hosted> {
  let standing: CallStanding = ownerStanding();
  const ferrets = new FakeFerrets();
  const daemon = runtimesDaemon(() => assembly) as DaemonImplementation<any>;
  const host = await testHost({
    plugins: [daemon],
    fakes: { ferrets },
    gate: new StandInAdmission(() => standing),
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  return {
    host,
    ferrets,
    as: next => {
      standing = next;
    },
  };
}
