import {
  type EnhancementAuthorizer,
  SttEnhancementService,
  type SttEnhancementServiceOptions,
  type SttEnhancementSubsystem,
  type SttMonotonicClockPort,
} from '../../src/lib/index.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import { voiceContribution } from '../../src/lib/runtime/mounts/stt.ts';

/**
 * Dictation: the one speech-to-text step the daemon still owns, repairing a dictated transcript with a hosted chat
 * model (`POST /v1/stt/enhance`). Recognition itself happens in the browser.
 *
 * See `./learning.ts` for what a module file owns. This module has no needs, no jobs and no releases. Its ONE seam is
 * the enhancer itself: it spends the operator's provider credential over the network, so `DaemonWorld` carries it as
 * `sttEnhancement` and a test replaces it (`seamsOf.voice` reads the effective world). {@link createSttEnhancement} is
 * how `buildWorld` builds the production one.
 */

/** The production adapter a test may replace. */
export interface VoiceSeams {
  /**
   * Typed as the MOUNT's narrow interface rather than as `SttEnhancementService`, so a test can answer the route
   * without an outbound transport, a secret reader and a stopwatch behind it.
   */
  readonly enhancement: SttEnhancementSubsystem;
}

/**
 * The production dictation enhancer: the outbound holder spends the provider credential, the operator's cleanup
 * settings are read per call, and one line per call is logged — sizes and reasons only, because the report type has no
 * field a transcript could ride in.
 */
export function createSttEnhancement(
  authorizer: EnhancementAuthorizer,
  clock: SttMonotonicClockPort,
  cleanup: NonNullable<SttEnhancementServiceOptions['cleanup']>,
): SttEnhancementService {
  return new SttEnhancementService(authorizer, clock, {
    cleanup,
    // One line per call, sizes and reasons only: the report type has no field a transcript could ride in.
    report: report =>
      process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), type: 'stt.enhance', data: report })}\n`),
  });
}

export const voiceModule: DaemonModule<VoiceSeams, void, SttEnhancementSubsystem> = {
  id: 'voice',
  build: (_needs, seams) => ({
    id: 'voice',
    provides: seams.enhancement,
    jobs: {},
    contributes: voiceContribution(seams.enhancement),
  }),
};
