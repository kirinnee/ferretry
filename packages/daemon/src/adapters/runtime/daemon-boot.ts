import {
  type AddressOccupant,
  type AddressProbeOutcome,
  defaultBindRetryPolicy,
  healthEndpoint,
  identifyAddressOccupant,
  shouldRetryBind,
  type BindRetryPolicy,
  type DaemonFetchPort,
  type MillisecondClockPort,
  type SleepPort,
} from '../../lib/runtime/boot.ts';

export interface DaemonHealthProbeOptions {
  readonly url: string;
  readonly token?: string;
  readonly timeoutMs?: number;
}

/**
 * Whether a failed request proves the address is FREE.
 *
 * Only an actively refused connection does: the kernel answering on behalf of a port nothing holds.
 * Every other failure — a timeout, a reset, a name that would not resolve — leaves the question open,
 * and an open question is not a vacancy. The runtime reports the refusal as an error code rather than
 * in the message, so the code is what is read; the text is kept for the refusal a human reads.
 */
function wasConnectionRefused(error: unknown): boolean {
  return (error as { readonly code?: unknown } | null)?.code === 'ConnectionRefused';
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * HTTP adapter that asks the configured address WHO is there.
 *
 * It used to ask only whether anything answered, and that was the bug: a different fleet's supervisor
 * replied 401, the boot read the reply as its own incumbent and exited 78 in silence. The reply is
 * read now — status and body both — and the judgement itself is the domain's, so this adapter does
 * nothing but turn one request into the evidence that decision is made from.
 */
export class DaemonHealthProbe {
  constructor(private readonly fetcher: DaemonFetchPort) {}

  async identify(options: DaemonHealthProbeOptions): Promise<AddressOccupant> {
    return identifyAddressOccupant(await this.observe(options));
  }

  private async observe(options: DaemonHealthProbeOptions): Promise<AddressProbeOutcome> {
    try {
      const response = await this.fetcher.fetch(healthEndpoint(options.url), {
        headers: options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
      });
      // A body that is not JSON is evidence too — it says the responder is not this daemon — so the
      // parse failure becomes `undefined` and the identification refuses on it rather than throwing
      // here, where the outcome would be indistinguishable from never having reached the address.
      const body = await response.json().catch(() => undefined);
      return { kind: 'answered', status: response.status, body };
    } catch (error) {
      return wasConnectionRefused(error) ? { kind: 'refused' } : { kind: 'unreachable', detail: describe(error) };
    }
  }
}

/** Performs a bounded retry around a concrete address-binding operation. */
export class DaemonBinder {
  constructor(
    private readonly sleep: SleepPort,
    private readonly clock: MillisecondClockPort,
    private readonly policy: BindRetryPolicy = defaultBindRetryPolicy(),
  ) {}

  async bind<T>(operation: () => T | Promise<T>): Promise<T> {
    const deadlineMs = this.clock.now() + this.policy.totalMs;
    let attempts = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        attempts += 1;
        if (!shouldRetryBind(error, this.clock.now(), deadlineMs, attempts, this.policy)) throw error;
        await this.sleep.sleep(this.policy.backoffMs);
      }
    }
  }
}
