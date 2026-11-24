import { implementDaemon } from '@ferretry/kernel/manifest';
import { DEFAULT_VOICE_CONFIG, type VoiceApi, VOICE_CONFIG } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { OutboundProviderAuthorizer } from './adapters/outbound-provider-authorizer.ts';
import { StateSpeedupTestLedger } from './adapters/state-speedup-test-ledger.ts';
import { JevProbe } from './lib/speedups/jev-probe.ts';
import { SpeedupsService } from './lib/speedups/service.ts';
import { type CleanupSettings, DEFAULT_CLEANUP_SETTINGS } from './lib/stt/enhancement.ts';
import { SttEnhancementService } from './lib/stt/enhancer.ts';
import { freemem } from 'node:os';
import { StateEngineFiles } from './adapters/state-engine-files.ts';
import {
  REPLY_WORKER_URL,
  startReplyThread,
  startSpeechThread,
  SPEECH_WORKER_URL,
} from './adapters/worker-speech-thread.ts';
import { REPLY_DIR } from './lib/reply/catalog.ts';
import { ReplyVoiceEngine } from './lib/reply/engine.ts';
import { ElevenLabsReplyVoice } from './lib/reply/elevenlabs.ts';
import { routeReplyVoice } from './lib/reply/router.ts';
import { StateReplySpend } from './adapters/state-reply-spend.ts';
import { SpeechEngine } from './lib/engine/engine.ts';
import { voiceStreamAccept } from './lib/stream/accept.ts';
import { voiceRoutes } from './routes.ts';

/**
 * Voice (§2.3), daemon half: the dictation enhancer (`POST /v1/stt/enhance`) and the speed-up keys' status and Test.
 *
 * It holds no credential. The provider key is spent only through the Vault's outbound holder, named by secret and
 * allowed hosts (`OutboundProviderAuthorizer`); the cleanup settings are `voice.yaml`, read per call so an edit takes
 * effect at once; one log line per call carries sizes and reasons only, because the report type has no field a
 * transcript could ride in.
 */
export default implementDaemon(manifest, {
  // The machine speech engine's thread: `fyd --check` starts and stops it, and a compiled binary embeds it.
  workers: { speech: SPEECH_WORKER_URL, reply: REPLY_WORKER_URL },
  build(ctx) {
    const { kernel } = ctx;
    const { vault, gate, ferrets } = ctx.needs;
    const authorizer = new OutboundProviderAuthorizer(vault);
    const stopwatch = { monotonicMs: () => kernel.clock.nowMs() };
    const log = kernel.log.child('stt');

    const cleanup = (): CleanupSettings => kernel.config.file(VOICE_CONFIG)?.postProcessing ?? DEFAULT_CLEANUP_SETTINGS;
    const enhancement = new SttEnhancementService(authorizer, stopwatch, {
      cleanup,
      report: report => log.info('stt.enhance', { ...report }),
    });
    const speedups = new SpeedupsService({
      authorizer,
      secrets: { list: async () => await vault.names() },
      ledger: new StateSpeedupTestLedger(kernel.state),
      clock: { monotonicMs: stopwatch.monotonicMs, now: () => kernel.clock.now() },
      guard: new JevProbe(authorizer),
    });

    const engineLog = kernel.log.child('engine');
    const engine = new SpeechEngine({
      http: { request: async (url, init) => await kernel.fetch.request(url, init) },
      files: new StateEngineFiles(kernel.state, kernel.hostFacts),
      clock: kernel.clock,
      machine: () => kernel.identity.daemonName,
      start: () => startSpeechThread(kernel.workers),
      availableMemory: () => freemem(),
      log: {
        info: (message, fields) => engineLog.info(message, fields),
        warn: (message, fields) => engineLog.warn(message, fields),
      },
    });
    kernel.lifecycle.onStop(() => void engine.unload());

    // The reply voice (Kokoro): installed apart from the speech engine, and its own worker thread so listening never waits.
    const replyLog = kernel.log.child('reply');
    const reply = new ReplyVoiceEngine({
      http: { request: async (url, init) => await kernel.fetch.request(url, init) },
      files: new StateEngineFiles(kernel.state, kernel.hostFacts, REPLY_DIR),
      clock: kernel.clock,
      machine: () => kernel.identity.daemonName,
      start: () => startReplyThread(kernel.workers),
      availableMemory: () => freemem(),
      log: {
        info: (message, fields) => replyLog.info(message, fields),
        warn: (message, fields) => replyLog.warn(message, fields),
      },
    });
    kernel.lifecycle.onStop(() => void reply.unload());

    // ElevenLabs, the optional reply voice: spent through the same outbound holder as the other keys, counted per character.
    const elevenlabsLog = kernel.log.child('elevenlabs');
    const elevenlabs = new ElevenLabsReplyVoice({
      authorizer,
      secrets: { list: async () => await vault.names() },
      spend: new StateReplySpend(kernel.state),
      settings: () => (kernel.config.file(VOICE_CONFIG) ?? DEFAULT_VOICE_CONFIG).replyVoice,
      today: () => new Intl.DateTimeFormat('en-CA').format(new Date(kernel.clock.nowMs())),
      monotonicMs: () => kernel.clock.nowMs(),
      log: { info: (message, fields) => elevenlabsLog.info(message, fields) },
    });
    // The voice a stream speaks in is chosen per use by voice.yaml, so a change in Settings is heard from the next line.
    const replyVoice = routeReplyVoice({
      provider: () => (kernel.config.file(VOICE_CONFIG) ?? DEFAULT_VOICE_CONFIG).replyVoice.provider,
      kokoro: reply,
      elevenlabs,
    });

    const voice: VoiceApi = {
      engine,
      enhance: async input => await enhancement.enhance(input),
      speedups: async () => await speedups.view(),
      testSpeedup: async provider => await speedups.test(provider),
      settings: () =>
        kernel.config.file(VOICE_CONFIG) ?? { ...DEFAULT_VOICE_CONFIG, postProcessing: DEFAULT_CLEANUP_SETTINGS },
    };

    // The voice stream: each finished turn is sent to the ferret through Conversation's send, as the person's own message.
    const streamLog = kernel.log.child('stream');
    const sockets = {
      'GET /v1/voice/stream': voiceStreamAccept({
        engine,
        reply: replyVoice,
        clock: kernel.clock,
        send: () => {
          const conversation = ctx.uses.conversation.current();
          if (conversation === undefined) return undefined;
          return async (ferretId, message, sendId) => {
            const sent = await conversation.send(
              ferretId as Parameters<typeof conversation.send>[0],
              { kind: 'owner' },
              { message, sendId },
            );
            return sent.ok ? { ok: true } : { ok: false, code: 'send_refused' };
          };
        },
        resolveFerret: async reference => {
          const address = await ferrets.resolve(reference);
          return address.kind === 'ferret' ? address.id : undefined;
        },
        fleetUseGranted: () => gate.policy()?.grants.fleet.use === true,
        audit: async draft => await gate.audit(draft),
        log: { info: (message, fields) => streamLog.info(message, fields) },
      }),
    };

    return { routes: voiceRoutes(enhancement, speedups, engine, reply, elevenlabs), sockets, provides: { voice } };
  },
});
