import type { StatePort } from '@ferretry/kernel/contract';
import { SPEEDUP_TESTS_STATE } from '../../contract/index.ts';
import type { SpeedupTestLedgerPort } from '../lib/speedups/ports.ts';

/**
 * The last Test of each speed-up key, in `state/voice/speedup-tests.json`. It holds names, codes, sentences and
 * instants — never a key, and never a provider's reply. A document that is missing or damaged reads as `undefined`,
 * which the domain treats as "never tested".
 */
export class StateSpeedupTestLedger implements SpeedupTestLedgerPort {
  constructor(private readonly state: StatePort) {}

  async read(): Promise<unknown> {
    const read = await this.state.read(SPEEDUP_TESTS_STATE);
    return read.ok ? read.value : undefined;
  }

  async write(document: unknown): Promise<void> {
    await this.state.write(SPEEDUP_TESTS_STATE, document as { results: Record<string, unknown> });
  }
}
