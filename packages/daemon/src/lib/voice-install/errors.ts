import type { VoiceEngineCode } from '@ferretry/protocol';

/**
 * A refusal or failure the install can name: the code is the one the routes answer with
 * (`VOICE_ENGINE_CODES`), the message is a sentence for a person.
 */
export class VoiceInstallError extends Error {
  constructor(
    readonly code: VoiceEngineCode,
    message: string,
  ) {
    super(message);
    this.name = 'VoiceInstallError';
  }
}
