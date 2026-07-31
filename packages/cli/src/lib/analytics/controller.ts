import type { IAnalyticsGateway, IAnalyticsOutput } from './ports.ts';
import { renderAnalytics } from './render.ts';

/** Options the analytics command accepts. */
export interface AnalyticsCommandOptions {
  /** Emit the protocol response verbatim instead of the terminal table. */
  readonly json?: boolean;
}

/**
 * Drives `fy analytics …`: hands the query to the daemon, which owns parsing and aggregation, and
 * renders whatever comes back. The CLI deliberately does not understand the query language — one
 * parser, in the daemon, is what keeps the CLI and the PWA reporting the same numbers.
 */
export class AnalyticsController {
  constructor(
    private readonly gateway: IAnalyticsGateway,
    private readonly out: IAnalyticsOutput,
  ) {}

  async query(words: readonly string[], options: AnalyticsCommandOptions): Promise<void> {
    const query = words.join(' ').trim();
    const response = await this.gateway.analytics(query === '' ? undefined : query);
    this.out.success(options.json === true ? JSON.stringify(response, null, 2) : renderAnalytics(response));
  }
}
