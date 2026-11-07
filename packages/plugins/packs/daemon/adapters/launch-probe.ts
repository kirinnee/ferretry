import type { RuntimeId, RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import type { RuntimeFactsApi } from '../../contract/index.ts';
import type { PackProbeOutcome, PackProbePort, PackProbeRequest, ProbeFailureCode } from '../lib/probe.ts';

const CODES: Readonly<Record<string, ProbeFailureCode | undefined>> = {
  not_signed_in: 'not_logged_in',
  no_login: 'not_logged_in',
};

/**
 * The start probe behind {@link PackProbePort}: the Runtimes provider's own answer to "could a start on this runtime
 * launch now?". Today's probe also ran the runtime's launcher once and asked the model to "reply OK"; spawning an
 * arbitrary launcher is outside Packs' permissions (no plugin may spawn `*`), so the real round trip belongs to a
 * one-shot operation on the harness, which Ferrets has not offered. Until it does, a PASS here proves the runtime
 * resolves, is switched on and is signed in, not that the model answers. The probe cache keeps it per runtime.
 */
export class RuntimeLaunchProbe implements PackProbePort {
  constructor(
    private readonly runtimes: () => (RuntimesApi & Partial<RuntimeFactsApi>) | undefined,
    private readonly nowMs: () => number,
  ) {}

  async probe(request: PackProbeRequest): Promise<PackProbeOutcome> {
    const started = this.nowMs();
    const ms = (): number => Math.max(0, Math.round(this.nowMs() - started));
    const runtimes = this.runtimes();
    if (runtimes === undefined) return { ok: false, ms: ms(), reason: 'Runtimes is off, so nothing can be launched' };
    const known = (await runtimes.catalog?.())?.find(runtime => runtime.wrapper === request.wrapper);
    if (known === undefined) return { ok: false, ms: ms(), reason: 'it cannot be launched: no such runtime' };
    const resolved = await runtimes.resolve(known.id as RuntimeId);
    if (resolved.ok) return { ok: true, ms: ms() };
    const code = CODES[resolved.refusal];
    return {
      ok: false,
      ms: ms(),
      reason: `it cannot be launched: ${resolved.sentence}`,
      ...(code === undefined ? {} : { code }),
    };
  }
}
