import { implementDaemon } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { onboardingRoutes } from './routes/onboarding.ts';
import { OnboardingService } from './lib/service.ts';

/**
 * Onboarding's daemon half (§2.3, §6.1). The steps are the post-build snapshot's, read on every call (the snapshot is
 * frozen only after the build); where each stands is `state/onboarding/progress.json`. There is no hook: a step's
 * live check is a route its owning plugin declares, called by the app or the CLI.
 */
export default implementDaemon(manifest, {
  build: ({ kernel }) => {
    const onboarding = new OnboardingService({
      entries: () => kernel.snapshot.current().onboarding,
      state: kernel.state,
      clock: kernel.clock,
      events: kernel.events,
    });
    return { routes: onboardingRoutes(onboarding), provides: { onboarding } };
  },
});
