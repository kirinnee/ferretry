import type { SttEnhancementErrorCode, SttErrorCode } from '@ferretry/protocol';

/** Raised by pure decision logic; adapters translate it into a wire error view. */
export class SttError extends Error {
  constructor(
    readonly code: SttErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SttError';
  }
}

/** Audio decoding rejects only in ways the transport can report verbatim. */
export class SttAudioError extends SttError {
  constructor(code: Extract<SttErrorCode, 'bad_audio' | 'too_long'>, message: string) {
    super(code, message);
    this.name = 'SttAudioError';
  }
}

/** Enhancement has its own error vocabulary because it talks to a third party. */
export class SttEnhancementError extends Error {
  constructor(
    readonly code: SttEnhancementErrorCode,
    message: string,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SttEnhancementError';
  }
}
