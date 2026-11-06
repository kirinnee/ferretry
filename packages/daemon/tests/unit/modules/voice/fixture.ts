import type { SttEnhancementSubsystem } from '../../../../src/lib/runtime/mounts/stt.ts';
import type { BuiltModule, ModuleLifecycle } from '../../../../src/lib/runtime/modules.ts';
import { voiceModule } from '../../../../bin/modules/voice.ts';
import { FakeSttEnhancer } from '../../runtime/mounts/support.ts';

/**
 * THE `voice` MODULE'S TEST CONSTRUCTION — a per-module fixture fragment (see `../learning/fixture.ts`).
 *
 * The REAL `voiceModule.build(needs, seams, lifecycle)` over a test enhancer: the seam `DaemonWorld` carries as
 * `sttEnhancement`, which a test substitutes because the production one spends the operator's provider account.
 * Building starts nothing, so there is no timer or async work to leave behind in the shared unit process.
 */

const LIFECYCLE: ModuleLifecycle = { onRelease: () => undefined, releasing: () => false };

/** The module as production builds it, over the fixture's enhancer. */
export function builtVoice(): BuiltModule<SttEnhancementSubsystem> {
  return voiceModule.build(undefined, { enhancement: new FakeSttEnhancer() }, LIFECYCLE);
}
