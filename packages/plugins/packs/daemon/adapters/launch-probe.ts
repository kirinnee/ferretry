import { RuntimeIdSchema, type RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import type { PackProbeOutcome, PackProbePort, PackProbeRequest, ProbeFailureCode } from '../lib/probe.ts';

const CODES: Readonly<Record<string, ProbeFailureCode | undefined>> = {
  not_signed_in: 'not_logged_in',
  no_login: 'not_logged_in',
};

/**
 * The start check behind {@link PackProbePort}: the Runtimes provider's own answer to "could a start on this runtime
 * launch now?" (`RuntimesApi.resolve`). A PASS proves the runtime resolves, is switched on and its login is signed in —
 * NOT that the model answers: a login that is signed in but out of quota passes. Today's probe also ran the runtime's
 * launcher once and asked the model to "reply OK"; spawning an arbitrary launcher is outside Packs' permissions, so that
 * round trip needs a one-shot harness run Ferrets or Runtimes does not offer yet (ports-pending). `request.wrapper` is
 * the runtime's name here (`CleanUpRuntime.wrapper`). The probe cache keeps a PASS per runtime.
 */
export class RuntimeLaunchProbe implements PackProbePort {
  constructor(
    private readonly runtimes: () => RuntimesApi | undefined,
    private readonly nowMs: () => number,
  ) {}

  async probe(request: PackProbeRequest): Promise<PackProbeOutcome> {
    const started = this.nowMs();
    const ms = (): number => Math.max(0, Math.round(this.nowMs() - started));
    const runtimes = this.runtimes();
    if (runtimes === undefined) return { ok: false, ms: ms(), reason: 'Runtimes is off, so nothing can be launched' };
    const id = RuntimeIdSchema.safeParse(request.wrapper);
    if (!id.success) return { ok: false, ms: ms(), reason: 'it cannot be launched: no such runtime' };
    const resolved = await runtimes.resolve(id.data);
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
