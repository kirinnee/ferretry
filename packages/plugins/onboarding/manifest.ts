import { definePlugin, route, screen, verb } from '@ferretry/kernel/manifest';
import {
  ONBOARDING_AUDIT,
  ONBOARDING_PROGRESS,
  ONBOARDING_READ_MODELS,
  ONBOARDING_WORDS,
  OnboardingChanged,
  OnboardingPort,
  OnboardingSteps,
} from './contract/index.ts';
import { audit, cap } from './contract/core.ts';

/**
 * Onboarding (§2.3, §6.1): the first run. It lists the steps every plugin declared in its manifest (the post-build
 * snapshot), runs their `find`, records the answers, and asks nothing a step did not need. Replaces today's
 * `fleet setup scan` (`GET /v1/fleet/setup/scan`, `fleet.configure`) and the app's onboarding feature, so the
 * descriptors follow the scan's: reading progress is `fleet.use`; running a find (it looks at the machine, like the
 * scan) and recording an answer are `fleet.configure`, the answer a person's act. None of them grants anything: what a
 * step asks for goes through the owning plugin's own governed route.
 */
export default definePlugin({
  id: 'onboarding',
  title: 'Onboarding',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['onboarding', 'command', 'view'],
  words: ONBOARDING_WORDS,

  provides: { onboarding: OnboardingPort },

  actions: {
    routes: [
      route('GET /v1/onboarding', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read' },
        guard: { none: 'step titles, states and one-sentence findings; never a credential or a sign-in path' },
      }),
      route('POST /v1/onboarding/steps/:plugin/:stepId/find', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'reads the machine like the setup scan did; writes nothing but a remembered finding' },
        guard: { none: 'one-sentence findings; a step never returns a credential or a sign-in path' },
      }),
      route('POST /v1/onboarding/steps/:plugin/:stepId', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'records which step the owner has answered; grants nothing' },
        guard: { none: 'the step state' },
      }),
      route('POST /v1/onboarding/reset', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(ONBOARDING_AUDIT.reset),
        guard: { none: 'nothing is returned' },
      }),
    ],
    cli: [
      verb('onboard', { summary: 'run the first run at a terminal: find what you have, ask only what is missing' }),
      verb('onboard status', { summary: 'the first-run steps and where each stands' }),
      verb('onboard reset', { summary: 'forget which steps were answered and start the first run again' }),
    ],
  },

  ui: {
    screens: [screen('onboarding', { path: '/onboarding' })],
  },

  data: {
    state: [ONBOARDING_PROGRESS],
    readModels: ONBOARDING_READ_MODELS,
    publishes: [OnboardingChanged],
  },

  hooks: {
    offers: [{ hook: OnboardingSteps }],
  },

  permissions: { roots: [], network: [], spawn: [], secrets: [] },
});
