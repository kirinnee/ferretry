import type { StatePort } from '@ferretry/kernel/contract';
import { PACK_JEV_SPEND } from '../../contract/index.ts';

/**
 * Jev's Pack-mode spend, per UTC day, in `state/packs/jev-spend.json`: `{day, usd}`. A day that is not today reads as
 * nothing spent; a damaged document reads as the cap already reached, so a broken ledger can never let Jev spend without
 * bound.
 */
export class StatePackSpendLedger {
  constructor(
    private readonly state: Pick<StatePort, 'read' | 'update'>,
    private readonly today: () => string,
  ) {}

  async spent(): Promise<number> {
    const read = await this.state.read(PACK_JEV_SPEND);
    if (!read.ok) return Number.POSITIVE_INFINITY;
    const kept = read.value;
    return kept !== undefined && kept.day === this.today() ? kept.usd : 0;
  }

  async record(usd: number): Promise<void> {
    const day = this.today();
    await this.state.update(PACK_JEV_SPEND, current => ({
      format: 1 as const,
      day,
      usd: (current?.day === day ? current.usd : 0) + Math.max(0, usd),
    }));
  }
}
