import { definePlugin, route, screen, settingsTab, verb } from '@ferretry/kernel/manifest';
import {
  ONBOARDING_AUDIT,
  ONBOARDING_PROGRESS,
  ONBOARDING_READ_MODELS,
  ONBOARDING_WORDS,
  OnboardingChanged,
  OnboardingPort,
} from './contract/index.ts';
import { RuntimesPort } from '@ferretry/plugin-runtimes/contract';
import { audit, cap } from '@ferretry/core-gate/contract';

/**
 * Onboarding (§2.3, §6.1): the first run. It lists the steps every plugin declared in its manifest (the post-build
 * snapshot) and records the answers. A step's live check is a route its owning plugin declares, which the app calls
 * (Claude Code / Codex: their update view; Shells: `GET /v1/shells/nix`; Runtimes: the setup scan). Replaces today's
 * `fleet setup scan` (`fleet.configure`) and the app's onboarding feature, so the descriptors follow the scan's: reading
 * progress is `fleet.use`; recording an answer is `fleet.configure`, a person's act. None of them grants anything.
 */
export default definePlugin({
  id: 'onboarding',
  title: 'Onboarding',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['onboarding', 'command', 'view'],
  words: ONBOARDING_WORDS,

  // Runtimes is optional: it says whether the machine is set up (it has a runtime). Off, the answer is "not set up".
  uses: { runtimes: RuntimesPort },
  provides: { onboarding: OnboardingPort },

  actions: {
    routes: [
      route('GET /v1/onboarding', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read' },
        guard: { none: 'step titles, states and step ids and states only' },
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
    // Daemon-less on purpose: the first run happens before any daemon is paired.
    screens: [
      screen('onboarding', { path: '/onboarding', daemonless: true }),
      // The steps every plugin declared, on one machine: it OFFERS the `onboarding.step` slot (contract/slots.ts).
      screen('steps', { path: 'onboarding/steps' }),
      // v4's address for the same first run (`/d/<machine>/setup`): a bookmark or an old link still lands on the steps.
      screen('setup', { path: 'setup' }),
    ],
    // The way back to the steps screen for a machine that was paired but not set up: nothing else links to it.
    settings: [settingsTab('setup', { label: 'Setup', order: 60 })],
  },

  data: {
    state: [ONBOARDING_PROGRESS],
    readModels: ONBOARDING_READ_MODELS,
    publishes: [OnboardingChanged],
  },

  permissions: { roots: [], network: [], spawn: [], secrets: [] },
});
