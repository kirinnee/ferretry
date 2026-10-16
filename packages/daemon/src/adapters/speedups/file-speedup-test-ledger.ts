import type { SpeedupTestLedgerPort } from '../../lib/index.ts';

/** The two calls this ledger makes on the state home's confined filesystem. */
export interface SpeedupLedgerFiles {
  readText(path: string): Promise<string | undefined>;
  writeTextAtomic(path: string, text: string): Promise<void>;
}

/**
 * The last Test of each speed-up key, in one small document inside the state home.
 *
 * It holds names, codes, sentences and instants — never a key, and never a provider's reply. A
 * document that is missing, unreadable or not JSON reads as `undefined`, which the domain treats as
 * "never tested": the worst a damaged ledger can do is make a working key ask to be tested again.
 */
export class FileSpeedupTestLedger implements SpeedupTestLedgerPort {
  constructor(
    private readonly files: SpeedupLedgerFiles,
    private readonly path: string,
  ) {}

  async read(): Promise<unknown> {
    const raw = await this.files.readText(this.path).catch(() => undefined);
    if (raw === undefined || raw.trim() === '') return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  async write(document: unknown): Promise<void> {
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(document, null, 2)}\n`);
  }
}
