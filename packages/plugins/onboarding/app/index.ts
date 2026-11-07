import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { onboardingScreen } from './onboarding-screen.ts';

/**
 * Onboarding's app half: the 'onboarding' screen. Thin: the screen's controller is `onboarding-screen.ts`; the page
 * that renders it is the React `onboarding-page.tsx`, which needs the app shell (see NEEDS-APP-SHELL.txt).
 */
export default implementApp(manifest, {
  build: ({ client }) => {
    const screen = onboardingScreen(client);
    return { screens: { onboarding: () => screen } };
  },
});
