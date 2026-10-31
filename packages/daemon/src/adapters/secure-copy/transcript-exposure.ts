import type { CopyExposurePort, TranscriptFileResolver } from '../../lib/index.ts';
import { transcriptExposure } from '../../lib/index.ts';

/** How much of a transcript's end is searched: enough for a long session, bounded so a capture stays quick. */
export const TRANSCRIPT_EXPOSURE_BYTES = 32 * 1024 * 1024;

/**
 * Looks for a just-captured value in the session's own transcript FILE, read raw from its end: the parsed tail
 * the operator reads cuts long strings, and those are exactly where a token printed by a tool would sit. The value
 * is matched in memory and never written anywhere; a file that cannot be found or read answers `unknown`.
 */
export class TranscriptFileExposure implements CopyExposurePort {
  constructor(
    private readonly files: TranscriptFileResolver,
    private readonly tail: (file: string, bytes: number) => Promise<string> = async (file, bytes) => {
      const handle = Bun.file(file);
      // A missing file reads as empty text, which would answer `clean`: "the agent never saw it" from no evidence.
      if (!(await handle.exists())) throw new Error('the transcript file is not there');
      return await handle.slice(Math.max(0, handle.size - bytes)).text();
    },
  ) {}

  async transcriptHolds(sessionId: string, value: string): Promise<'found' | 'clean' | 'unknown'> {
    const file = await this.files.file(sessionId).catch(() => undefined);
    if (file === undefined) return 'unknown';
    try {
      return transcriptExposure(await this.tail(file, TRANSCRIPT_EXPOSURE_BYTES), value);
    } catch {
      return 'unknown';
    }
  }
}
