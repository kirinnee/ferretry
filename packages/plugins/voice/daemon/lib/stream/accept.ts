import { ApiError, type SocketAccept } from '@ferretry/kernel/contract';
import type { Clock } from '@ferretry/kernel/contract';
import type { VoiceEngineApi } from '../../../contract/index.ts';
import { StreamRegistry } from './registry.ts';
import { VoiceStream, type StreamParts } from './session.ts';

/** What `GET /v1/voice/stream` needs from the daemon. */
export interface VoiceStreamDeps {
  readonly engine: Pick<VoiceEngineApi, 'view' | 'transcribe' | 'detectSpeech'>;
  readonly clock: Pick<Clock, 'nowMs' | 'every' | 'after'>;
  /** Read at each stream, so Conversation loading or unloading later is seen. `undefined` = Conversation is off. */
  readonly send: () => StreamParts['send'];
  readonly log: StreamParts['log'];
  readonly registry?: StreamRegistry;
  readonly nonce?: () => string;
  readonly streamId?: () => string;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const randomNonce = (): string => hex(crypto.getRandomValues(new Uint8Array(8)));
const randomStreamId = (): string => hex(crypto.getRandomValues(new Uint8Array(6)));

/** A caller as the registry counts it: its paired device, or the host's own admin token. */
function deviceKeyOf(call: {
  readonly credential?: { readonly tokenClass: string; readonly principal?: { readonly holder: string } };
}): string {
  const credential = call.credential;
  return credential?.tokenClass === 'device' && credential.principal !== undefined
    ? `device:${credential.principal.holder}`
    : 'host';
}

/**
 * The socket's accept step: everything that can be said as an HTTP status BEFORE the protocol switches (§14), so a
 * refused stream is a status and not a stream that opened and then said no.
 */
export function voiceStreamAccept(deps: VoiceStreamDeps): SocketAccept {
  const registry = deps.registry ?? new StreamRegistry();
  return async call => {
    const device = deviceKeyOf(call as Parameters<typeof deviceKeyOf>[0]);
    const view = await deps.engine.view();
    if (view.state !== 'ready')
      throw new ApiError(409, `Voice mode needs speech installed on ${view.machine}.`, 'voice_not_ready');
    const verdict = registry.wouldAdmit(device);
    if (verdict !== 'ok')
      throw new ApiError(
        429,
        verdict === 'device_busy'
          ? 'This device already has a voice stream open.'
          : `${view.machine} is already serving voice chats.`,
        'voice_busy',
      );
    return async downstream => {
      const slot = registry.admit(device);
      if (!slot.ok) throw new ApiError(429, 'This machine is busy with voice chats.', 'voice_busy');
      return new VoiceStream({
        engine: deps.engine,
        clock: deps.clock,
        downstream,
        streamId: (deps.streamId ?? randomStreamId)(),
        nonce: deps.nonce ?? randomNonce,
        send: deps.send(),
        claimFerret: ferret => registry.claimFerret(ferret),
        onEnd: slot.release,
        log: deps.log,
      });
    };
  };
}
