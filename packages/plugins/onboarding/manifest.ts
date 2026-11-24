import { appAction, definePlugin, panel, route, screen, settingsTab, verb } from '@ferretry/kernel/manifest';
import {
  ONBOARDING_AUDIT,
  ONBOARDING_PROGRESS,
  ONBOARDING_READ_MODELS,
  ONBOARDING_WORDS,
  OnboardingChanged,
  OnboardingPort,
} from './contract/index.ts';
import { FerretsPort } from '@ferretry/core-ferrets/contract';
import { LoginsPort } from '@ferretry/plugin-logins/contract';
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
  // Logins offers the provider catalog the "Which AI do you want to use?" page lists under Others; Ferrets says which harnesses are
  // installed (the page lists those, never a list of its own).
  uses: { runtimes: RuntimesPort, logins: LoginsPort, ferrets: FerretsPort },
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
      verb('onboard', {
        summary: 'run the first run at a terminal: find what you have, ask only what is missing',
        args: [],
        options: [
          { flag: '-y, --yes', help: 'go ahead without asking' },
          { flag: '--check', help: 'say what is present and what is missing, and change nothing' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
      // The question-by-question machine setup, as v4's `daemon setup`: it drives the routes Runtimes serves to the app.
      verb('daemon setup', {
        summary: 'set this machine up: install the tools, then choose whether to use your Claude Code and Codex',
        args: [],
        options: [
          { flag: '--dry-run', help: 'show what would change and change nothing' },
          { flag: '-y, --yes', help: 'accepted for scripts; setup still asks its questions, so it needs a terminal' },
          { flag: '--json', help: 'print the change and its outcome as JSON' },
        ],
      }),
      verb('onboard status', {
        summary: 'the first-run steps and where each stands',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('onboard reset', { summary: 'forget which steps were answered and start the first run again', args: [] }),
    ],
    // The Home stepper's buttons. Each sends the person to the place that does the job; the acts below are what those
    // places call, named here so the stepper's reads of Access, Projects and Ferrets are a declared consumption.
    app: [
      appAction('first-run.passkey', { on: 'daemon', label: 'Add a passkey', calls: 'POST /v1/passkeys' }),
      appAction('first-run.ferret', { on: 'daemon', label: 'New ferret', calls: 'POST /v1/ferrets' }),
      appAction('first-run.project', { on: 'daemon', label: 'Create a project', calls: 'POST /v1/projects' }),
    ],
  },

  ui: {
    // Daemon-less on purpose: the first run happens before any daemon is paired.
    screens: [
      screen('onboarding', { path: '/onboarding', daemonless: true, chrome: 'none' }),
      // The address a hand-off link carries to the OTHER device (`/setup#fy-setup=…`, v4's `setupPath`): the SAME first-run page,
      // drawn by the same view, with the place the link carries read from its fragment. One page, two addresses.
      screen('handoff', { path: '/setup', daemonless: true, chrome: 'none' }),
      // The setup flow: every plugin's declared steps as ONE multi-page stepper, drawn alone (no drawer, bars or side
      // column); it OFFERS the `onboarding.step` slot (contract/slots.ts), one panel mounted per page.
      screen('flow', { path: 'onboarding/setup', chrome: 'none' }),
      // The old steps list's address (and v4's `/d/<machine>/setup`): a bookmark or an old link lands in the flow.
      screen('steps', { path: 'onboarding/steps' }),
      screen('setup', { path: 'setup' }),
    ],
    // The way back to the steps screen for a machine that was paired but not set up: nothing else links to it.
    settings: [settingsTab('setup', { icon: 'rocket', group: 'agents', label: 'Setup', order: 60 })],
    // Home: the first-run stepper (Pair > Passkey > Name > Claude Code > Codex > Project) while any step is open.
    panels: [
      panel('daemon.status', { id: 'first-run-stepper', order: 1 }),
      // Onboarding's own two pages: name this machine (the machine's) and appearance (this device's).
      // The first page of setup: which AI the person wants (the flow hides the pages of every harness not picked).
      panel('onboarding.step', { id: 'agents-step', order: 2 }),
      panel('onboarding.step', { id: 'name-step', order: 5 }),
      // One Permissions page for every harness the person picked (Claude Code and Codex together).
      panel('onboarding.step', { id: 'permissions-step', order: 6 }),
      panel('onboarding.step', { id: 'appearance-step', order: 1 }),
    ],
  },

  onboarding: [
    { id: 'agents', title: 'Which AI do you want to use?', order: 2, group: 'This machine', stepHost: true },
    { id: 'name', title: 'Name this machine', order: 5, group: 'This machine', stepHost: true },
    { id: 'permissions', title: 'Permissions', order: 6, group: 'This machine', stepHost: true },
    { id: 'appearance', title: 'Appearance', order: 1, side: 'client', group: 'This device', stepHost: true },
  ],

  data: {
    state: [ONBOARDING_PROGRESS],
    readModels: ONBOARDING_READ_MODELS,
    publishes: [OnboardingChanged],
  },

  permissions: { roots: [], network: [], spawn: [], secrets: [] },
});
