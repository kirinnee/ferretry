import { type IFyApiClient, type LimitsView, LimitsViewSchema } from '@ferretry/protocol';

/** The route the app's limits panel reads; the CLI reads the same one. */
const LIMITS_PATH = '/v1/cgroups/config';

/**
 * The limits block `fy daemon status` adds: the daemon's own plain-words lines, verbatim, or nothing.
 *
 * The sentences are written once, by the daemon (`lib/cgroups/view.ts`), so the terminal and the app say
 * the same thing. Nothing, rather than a failure, for every reason the read can fail — no token yet, an
 * older daemon with no such route or an older body, a daemon that stopped since the health probe —
 * because `status` reports on the daemon and its exit code is the daemon's, never this block's.
 */
export class ProtocolLimitsStatusReader {
  constructor(
    private readonly client: Pick<IFyApiClient, 'request'>,
    private readonly timeoutMs = 3_000,
  ) {}

  async read(): Promise<LimitsView | undefined> {
    try {
      return await this.client.request(LIMITS_PATH, LimitsViewSchema, undefined, this.timeoutMs);
    } catch {
      return undefined;
    }
  }
}

/** The human lines: a heading, then the daemon's sentences, each indented under it. */
export function renderLimitsStatus(view: LimitsView): readonly string[] {
  return ['  Limits:', ...view.lines.map(line => `    ${line}`), ...view.warnings.map(line => `    warning: ${line}`)];
}
