import type { SttEnhancementErrorCode } from '@ferretry/protocol';

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
