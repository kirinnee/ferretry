import type { MaskSource } from '../../../contract/index.ts';

/** A declared mask provider could not open its values; the caller refuses rather than serve unmasked text. */
export class MaskSourceUnavailableError extends Error {
  constructor() {
    super('mask source unavailable');
    this.name = 'MaskSourceUnavailableError';
  }
}

/**
 * The hook provider's values, asked fresh on EVERY call and kept by nothing — as today, which opened the login vault
 * and the 2FA seeds on every read. The snapshot lives only as long as the one read or one run that took it (S20),
 * like `SecretRedactor.batch`. Only masking holds this source; nothing that resolves a named secret receives it.
 *
 * A DECLARED provider that is unavailable, throws or has lost its handler REFUSES (fails closed, S19): the daemon
 * cannot know what to hide, and serving text it cannot scrub would be the leak. Its error is never exposed — it may
 * quote one of the values it was opening. Only an UNDECLARED provider (`absent`) masks nothing.
 */
export class DeclaredMaskSource implements MaskSource {
  constructor(private readonly provider: () => MaskSource | 'unavailable' | 'absent') {}

  async values(): Promise<ReadonlyMap<string, string>> {
    let source: MaskSource | 'unavailable' | 'absent';
    try {
      source = this.provider();
    } catch {
      throw new MaskSourceUnavailableError();
    }
    if (source === 'absent') return new Map();
    if (source === 'unavailable') throw new MaskSourceUnavailableError();
    try {
      return new Map(await source.values());
    } catch {
      throw new MaskSourceUnavailableError();
    }
  }
}
