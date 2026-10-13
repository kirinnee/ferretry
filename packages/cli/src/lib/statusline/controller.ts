import {
  CREDENTIAL_ENV,
  CredentialIdSchema,
  type PassiveUsageRecord,
  parseClaudeStatuslineRateLimits,
} from '@ferretry/fleet';

/**
 * `fy statusline` — what every Claude runtime's `statusLine.command` runs (account-model §8.1.3).
 *
 * Claude hands its statusLine command the turn's JSON on stdin, `rate_limits` included. This records
 * that block as the credential's PASSIVE usage reading — free, it was already sent — and then runs the
 * person's OWN statusLine command, if their settings named one, with the same stdin, so what they see
 * is exactly what they saw before. Theirs is chained, never replaced.
 *
 * A status line must never break a session, so nothing here fails loudly: input that is not JSON, a
 * missing `FY_CREDENTIAL` or a write that fails all just skip the recording, and the person's command
 * still runs. The exit code is theirs.
 */

/** Reading the whole of stdin, bounded. */
export interface StatuslineInput {
  read(): Promise<string>;
}

/** Where a credential's passive reading is kept. */
export interface StatuslineUsageSink {
  write(credentialId: string, record: PassiveUsageRecord): Promise<void>;
}

/** Running the person's own statusLine command with this stdin; its output goes straight to ours. */
export interface StatuslineChain {
  run(command: string, stdin: string): Promise<number>;
}

export interface StatuslineDeps {
  readonly input: StatuslineInput;
  readonly sink: StatuslineUsageSink;
  readonly chain: StatuslineChain;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
  setExitCode(code: number): void;
}

export interface StatuslineOptions {
  /** The person's own statusLine command, chained after the recording. */
  readonly own?: string;
}

/** The passive record one statusLine payload yields, or nothing when it measured nothing. */
export function statuslineUsageRecord(payload: string, at: number): PassiveUsageRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
  const reading = parseClaudeStatuslineRateLimits(parsed);
  if (!reading.hasQuotaSignal) return undefined;
  return {
    version: 1,
    source: 'claude-statusline',
    at,
    ...(reading.shortWindow === undefined ? {} : { fiveHour: reading.shortWindow }),
    ...(reading.longWindow === undefined ? {} : { weekly: reading.longWindow }),
  };
}

export class StatuslineController {
  constructor(private readonly deps: StatuslineDeps) {}

  async run(options: StatuslineOptions): Promise<void> {
    const payload = await this.deps.input.read().catch(() => '');
    await this.#record(payload);
    const own = options.own?.trim() ?? '';
    if (own.length === 0) return;
    this.deps.setExitCode(await this.deps.chain.run(own, payload));
  }

  async #record(payload: string): Promise<void> {
    const id = CredentialIdSchema.safeParse(this.deps.environment[CREDENTIAL_ENV]?.trim());
    if (!id.success) return;
    const record = statuslineUsageRecord(payload, this.deps.now());
    if (record === undefined) return;
    try {
      await this.deps.sink.write(id.data, record);
    } catch {
      /* a status line never fails over its own bookkeeping */
    }
  }
}
