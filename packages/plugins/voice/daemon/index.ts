import { implementDaemon } from '@ferretry/kernel/manifest';
import { type VoiceApi, VOICE_CONFIG } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { OutboundProviderAuthorizer } from './adapters/outbound-provider-authorizer.ts';
import { StateSpeedupTestLedger } from './adapters/state-speedup-test-ledger.ts';
import { JevProbe } from './lib/speedups/jev-probe.ts';
import { SpeedupsService } from './lib/speedups/service.ts';
import { type CleanupSettings, DEFAULT_CLEANUP_SETTINGS } from './lib/stt/enhancement.ts';
import { SttEnhancementService } from './lib/stt/enhancer.ts';
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
  build(ctx) {
    const { kernel } = ctx;
    const { vault } = ctx.needs;
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

    const voice: VoiceApi = {
      enhance: async input => await enhancement.enhance(input),
      speedups: async () => await speedups.view(),
      testSpeedup: async provider => await speedups.test(provider),
      settings: () => kernel.config.file(VOICE_CONFIG) ?? { postProcessing: DEFAULT_CLEANUP_SETTINGS },
    };

    return { routes: voiceRoutes(enhancement, speedups), provides: { voice } };
  },
});
