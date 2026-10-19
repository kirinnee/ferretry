import type { FileSystemPort } from '../../lib/index.ts';

/**
 * Jev's Pack-mode spend, per UTC day, in the state home: one small JSON document, `{day, usd}`. A day
 * that is not today reads as nothing spent; an unreadable document reads as the cap already reached,
 * so a broken ledger can never let Jev spend without bound.
 */
export class FilePackSpendLedger {
  constructor(
    private readonly files: Pick<FileSystemPort, 'readText' | 'writeTextAtomic'>,
    private readonly path: string,
    private readonly today: () => string,
  ) {}

  private async read(): Promise<{ readonly day: string; readonly usd: number }> {
    const text = await this.files.readText(this.path);
    if (text === undefined) return { day: this.today(), usd: 0 };
    try {
      const parsed = JSON.parse(text) as { day?: unknown; usd?: unknown };
      if (typeof parsed.day !== 'string' || typeof parsed.usd !== 'number' || !Number.isFinite(parsed.usd))
        return { day: this.today(), usd: Number.POSITIVE_INFINITY };
      return parsed.day === this.today() ? { day: parsed.day, usd: parsed.usd } : { day: this.today(), usd: 0 };
    } catch {
      return { day: this.today(), usd: Number.POSITIVE_INFINITY };
    }
  }

  async spent(): Promise<number> {
    return (await this.read()).usd;
  }

  async record(usd: number): Promise<void> {
    const current = await this.read();
    const base = Number.isFinite(current.usd) ? current.usd : 0;
    await this.files.writeTextAtomic(
      this.path,
      `${JSON.stringify({ day: current.day, usd: base + Math.max(0, usd) })}\n`,
    );
  }
}
