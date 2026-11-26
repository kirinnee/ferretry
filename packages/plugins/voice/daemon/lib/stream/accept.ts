import { ApiError, type SocketAccept } from '@ferretry/kernel/contract';
import { AUDIT_KINDS, type AuditDraft, cap } from '@ferretry/core-gate/contract';
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import type { Clock } from '@ferretry/kernel/contract';
import type { VoiceEngineApi } from '../../../contract/index.ts';
import { StreamRegistry } from './registry.ts';
import { VoiceStream, type StreamParts } from './session.ts';

/** What `GET /v1/voice/stream` needs from the daemon. */
export interface VoiceStreamDeps {
  readonly engine: Pick<VoiceEngineApi, 'view' | 'transcribe' | 'detectSpeech'>;
  /** The machine's reply voice: asked about by a stream that wants it, never needed by one that does not. */
  readonly reply?: StreamParts['reply'];
  readonly clock: Pick<Clock, 'nowMs' | 'every' | 'after'>;
  /** Read at each stream, so Conversation loading or unloading later is seen. `undefined` = Conversation is off. */
  readonly send: () => StreamParts['send'];
  readonly log: StreamParts['log'];
  /** Which ferret a name or an id means; `undefined` when none or several do. */
  readonly resolveFerret: StreamParts['resolveFerret'];
  /**
   * The machine-wide `fleet.use`, read LIVE (`gate.yaml` in effect now; `false` while undetermined). The caller's own
   * governance is a snapshot taken when the stream opened, so this is what lets a narrowing of the machine's grant stop
   * the next message of a stream that is already open.
   */
  readonly fleetUseGranted: () => boolean;
  /** Writes one audit record (Gate's). */
  readonly audit: (draft: AuditDraft) => Promise<void>;
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

const FLEET_USE = cap('fleet', 'use');

/**
 * Whether a caller may use the fleet right now, for what voice chat sends: its own governance (a snapshot) AND, for a governed
 * caller, the machine-wide grant read live. The stream asks at its start and before every send; the phone's entry route asks too.
 */
export const mayUseFleet = (governance: CallerGovernance | undefined, fleetUseGranted: () => boolean): boolean =>
  governance?.decide(FLEET_USE).allowed === true && (!governance.governed || fleetUseGranted());

/** The record a typed send leaves (`POST /v1/ferrets/:ferretId/send`): the ferret is the subject, never the words. */
export function sentAuditDraft(actor: AuditDraft['actor'], ferretId: string): AuditDraft {
  return {
    event: AUDIT_KINDS['agent.prompted'],
    actor,
    subject: ferretId,
    outcome: 'succeeded',
    detail: { action: 'send', status: 200, via: 'voice' },
  };
}

/**
 * What one sent message leaves in the audit log. A record that could not be written is said (one line, names only) and
 * never stops the stream: an audit write never decides an outcome.
 */
export function sentRecorder(
  deps: Pick<VoiceStreamDeps, 'audit' | 'log'>,
  actor: AuditDraft['actor'],
  streamId: string,
): (ferretId: string) => void {
  return ferretId => {
    deps
      .audit(sentAuditDraft(actor, ferretId))
      .catch(() => deps.log.info('voice.stream.audit_failed', { stream: streamId }));
  };
}

/** Who the audit log names for this caller, as it names the same caller on a typed send. */
export function auditActorOf(call: {
  readonly credential?: { readonly tokenClass: string; readonly principal?: { readonly holder: string } };
}): AuditDraft['actor'] {
  const credential = call.credential;
  return credential?.tokenClass === 'device' && credential.principal !== undefined
    ? { kind: 'device', deviceId: credential.principal.holder }
    : { kind: 'host' };
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
    const governance = (call as { readonly governance?: CallerGovernance }).governance;
    const auditActor = auditActorOf(call);
    return async downstream => {
      const streamId = (deps.streamId ?? randomStreamId)();
      const slot = registry.admit(device);
      if (!slot.ok) throw new ApiError(429, 'This machine is busy with voice chats.', 'voice_busy');
      return new VoiceStream({
        engine: deps.engine,
        reply: deps.reply,
        clock: deps.clock,
        downstream,
        streamId,
        nonce: deps.nonce ?? randomNonce,
        send: deps.send(),
        mayChat: () => mayUseFleet(governance, deps.fleetUseGranted),
        resolveFerret: deps.resolveFerret,
        recordSent: sentRecorder(deps, auditActor, streamId),
        claimFerret: ferret => registry.claimFerret(ferret),
        entry: {
          enter: ferret => registry.enterVoice(ferret, deps.clock.nowMs()),
          leave: ferret => registry.leaveVoice(ferret),
        },
        onEnd: slot.release,
        log: deps.log,
      });
    };
  };
}
