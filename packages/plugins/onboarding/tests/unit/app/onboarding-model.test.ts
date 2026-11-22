/**
 * The setup screen's strings are a contract, not copy.
 *
 * Every command it shows is run by a stranger on a machine nobody here can see,
 * so the tests that matter are the ones that pin the text: against
 * `INSTALLATION.md` for the install routes, against `Taskfile.yaml` and
 * `wrangler.jsonc` for the relay ones.
 *
 * The journey tests exist for a different reason: the step list is a function of
 * WHICH COMPUTER runs the daemon and WHAT THIS DEVICE IS, and the
 * mistakes it can make are all bad in a way coverage cannot see. Offering a phone
 * a step it cannot act on sends a reader to a screen full of commands with nowhere
 * to type them; making a desktop pair by scanning its own screen is the indignity
 * this rewrite exists to remove; and explaining an install on a machine the reader
 * is not sitting at is a second copy of the instructions that will go wrong. So
 * every combination is asserted, on both devices.
 */

import { describe, expect, it } from 'bun:test';

import {
  DAEMON_INSTALL_COMMAND,
  DAEMON_SERVING_OUTPUT,
  DAEMON_START_COMMAND,
  DAEMON_STATUS_COMMAND,
  detectInstallChannel,
  firstOnboardingStep,
  furthestOnboardingStep,
  handoffTarget,
  INSTALL_CHANNELS,
  installChannel,
  isDaemonRouteId,
  isLastOnboardingStep,
  isOnboardingRouteId,
  isOnboardingStepId,
  isSetupTargetId,
  isStepOfRoute,
  isTargetPossible,
  journeyLabel,
  nextOnboardingStep,
  ONBOARDING_ROUTES,
  type OnboardingPath,
  onboardingRouteSteps,
  onboardingStep,
  onboardingStepCount,
  onboardingStepIndex,
  onboardingStepStatus,
  PAIR_COMMAND,
  PAIR_OPEN_COMMAND,
  pairingOnboardingStep,
  presumedTarget,
  previousOnboardingStep,
  questionBehindRoute,
  SETUP_TARGETS,
  targetBasis,
  VERIFY_COMMAND,
} from '../../../app/onboarding-model.ts';

const repoFile = async (path: string): Promise<string> =>
  await Bun.file(new URL(`../../../../../../${path}`, import.meta.url)).text();

const installationDoc = await repoFile('INSTALLATION.md');

/** A daemon standing up on the machine reading the page. */
const here = (route: 'first-time' | 'add-daemon' = 'first-time'): OnboardingPath => ({
  route,
  target: 'this',
  device: 'desktop',
});

/** The same, but the daemon lives somewhere the reader has to walk to. */
const away = (device: 'desktop' | 'mobile' = 'mobile', route: 'first-time' | 'add-daemon' = 'first-time') =>
  ({ route, target: 'other', device }) as OnboardingPath;

const client = (device: 'desktop' | 'mobile' = 'desktop'): OnboardingPath => ({ route: 'add-client', device });

describe('which computer runs the daemon', () => {
  it('offers two answers, this machine first, and says what each means', () => {
    expect(SETUP_TARGETS.map(target => target.id)).toEqual(['this', 'other']);
    for (const target of SETUP_TARGETS) expect(target.answer).not.toContain('\n');
    expect(SETUP_TARGETS.find(target => target.id === 'this')?.title).toBe('This computer');
    expect(SETUP_TARGETS.find(target => target.id === 'other')?.title).toBe('Another computer');
  });

  it('accepts only the two answers back from storage or a link', () => {
    expect(isSetupTargetId('this')).toBe(true);
    expect(isSetupTargetId('other')).toBe(true);
    expect(isSetupTargetId('the-cloud')).toBe(false);
    expect(isSetupTargetId(null)).toBe(false);
  });

  it('refuses to let a phone be the daemon, whatever asked for it', () => {
    // Agents need a terminal. This is the one rule the whole flow turns on, and
    // it is stated once rather than re-derived by every reader of an answer.
    expect(isTargetPossible('this', 'desktop')).toBe(true);
    expect(isTargetPossible('other', 'desktop')).toBe(true);
    expect(isTargetPossible('other', 'mobile')).toBe(true);
    expect(isTargetPossible('this', 'mobile')).toBe(false);
  });

  it('is FORCED on a phone, ASSUMED from scratch, and ASKED when a fleet exists', () => {
    // A phone is never asked something the hardware answers; a reader setting up
    // for the first time on a computer is overwhelmingly at the machine they mean;
    // a reader adding to a fleet has a real choice between machines they own.
    expect(targetBasis('first-time', 'mobile')).toBe('forced');
    expect(targetBasis('add-daemon', 'mobile')).toBe('forced');
    expect(targetBasis('first-time', 'desktop')).toBe('assumed');
    expect(targetBasis('add-daemon', 'desktop')).toBe('chosen');
    expect(presumedTarget('first-time', 'mobile')).toBe('other');
    expect(presumedTarget('add-daemon', 'mobile')).toBe('other');
    expect(presumedTarget('first-time', 'desktop')).toBe('this');
    expect(presumedTarget('add-daemon', 'desktop')).toBeUndefined();
  });
});

describe('the agents Ferretry runs', () => {
  it('are no step of any journey: the Claude and Codex steps of the setup flow install and sign in', () => {
    // r10 O5 (decision D1): "Install Claude Code or Codex" was a daemonless stage; the flow that follows pairing owns it now.
    for (const path of [here(), here('add-daemon'), away(), client()]) {
      expect(onboardingRouteSteps(path)).not.toContain('agents' as never);
    }
    expect(isOnboardingStepId('agents')).toBe(false);
  });
});

describe('the entry question', () => {
  it('asks what the reader HAS, and never what this device is', () => {
    expect(ONBOARDING_ROUTES.map(route => route.id)).toEqual(['first-time', 'add-client', 'add-daemon']);
    for (const route of ONBOARDING_ROUTES) {
      expect(route.answer).not.toContain('\n');
      expect(route.answer.length).toBeGreaterThan(0);
    }
    const route = (id: string) => ONBOARDING_ROUTES.find(candidate => candidate.id === id);
    // The answer a reader holding a live code recognises instantly.
    expect(route('first-time')?.title).toBe('First time');
    expect(route('first-time')?.answer).toBe('Set up a computer to run your agents, then this browser.');
    expect(route('add-client')?.title).toBe('Pair');
    expect(route('add-client')?.answer).toBe('Scan or upload a QR, or paste a link from a device you already use.');
    // And the one that no longer claims THIS machine becomes anything.
    expect(route('add-daemon')?.title).toBe('Set up a new daemon');
    expect(route('add-daemon')?.answer).toBe('Add one more computer to your fleet.');
    expect(route('add-daemon')?.answer).not.toContain('This machine');
  });

  it('is the same three answers on a phone, because none of them is impossible there', () => {
    // The defect this replaced: a phone was offered "add this as a daemon" and had
    // it withdrawn a screen later, which is a page arguing with itself.
    expect(ONBOARDING_ROUTES.map(route => route.title).join(' ')).not.toContain('this as a daemon');
  });

  it('accepts only the three entry ids back from storage', () => {
    expect(isOnboardingRouteId('add-daemon')).toBe(true);
    expect(isOnboardingRouteId('first-time')).toBe(true);
    expect(isOnboardingRouteId('add-client')).toBe(true);
    // Both routes this replaced: a stored place inside either names a journey gone.
    expect(isOnboardingRouteId('have-link')).toBe(false);
    expect(isOnboardingRouteId('agent')).toBe(false);
    expect(isOnboardingRouteId(1)).toBe(false);
    expect(isOnboardingRouteId(undefined)).toBe(false);
  });

  it('knows which entries lead into the daemon subflow', () => {
    expect(isDaemonRouteId('first-time')).toBe(true);
    expect(isDaemonRouteId('add-daemon')).toBe(true);
    expect(isDaemonRouteId('add-client')).toBe(false);
  });

  it('names the subflow on the step header rather than the entry', () => {
    // "Pair · step 1 of 2" would describe the entry and not the work
    // rather than what they are doing.
    expect(journeyLabel(client())).toBe('Pair this browser');
    expect(journeyLabel(here())).toBe('Get a daemon running');
    expect(journeyLabel(here('add-daemon'))).toBe('Add another daemon');
  });
});

describe('the steps each set of answers walks', () => {
  it('collapses pairing when the daemon is on the machine reading the page, and ends there', () => {
    // No `pair`, no `scan`: this browser IS a client of that daemon already. And no `agents`, `handoff` or `done`: the
    // setup flow takes over when the daemon answers (r10 O5).
    expect(onboardingRouteSteps(here('add-daemon'))).toEqual(['install', 'daemon', 'local']);
    expect(onboardingRouteSteps(here('add-daemon'))).not.toContain('scan');
    expect(onboardingRouteSteps(here())).toEqual(['install', 'daemon', 'local']);
  });

  it('has no "add your phone" step and no "you are set up" step on any journey', () => {
    for (const path of [here(), here('add-daemon'), away(), client()]) {
      expect(onboardingRouteSteps(path)).not.toContain('handoff' as never);
      expect(onboardingRouteSteps(path)).not.toContain('done' as never);
    }
  });

  it('spends ONE screen on a daemon that lives somewhere else, and teaches nothing there', () => {
    // The recursion: that computer opens this page and walks the list above,
    // answering "this one". A second copy of the install instructions written
    // about somebody else's keyboard is a copy that goes wrong.
    for (const device of ['desktop', 'mobile'] as const) {
      expect(onboardingRouteSteps(away(device))).toEqual(['elsewhere', 'scan']);
      expect(onboardingRouteSteps(away(device))).not.toContain('install');
      expect(onboardingRouteSteps(away(device, 'add-daemon'))).toEqual(['elsewhere', 'scan']);
    }
  });

  it('reads the same on a phone and on a computer, which is the point of that screen', () => {
    // `need-computer` existed only on a phone and its subject was this device's
    // unsuitability. A laptop standing up a home server reaches the same screen
    // and is not being refused anything.
    expect(onboardingRouteSteps(away('desktop'))).toEqual(onboardingRouteSteps(away('mobile')));
  });

  it('gives a reader who already has a daemon nothing to install', () => {
    for (const device of ['desktop', 'mobile'] as const) {
      expect(onboardingRouteSteps(client(device))).toEqual(['scan']);
      expect(onboardingStepCount(client(device))).toBe(1);
    }
  });

  it('never asks a stranger how other devices will reach the daemon', () => {
    // Direct is tried first and the hosted relay is the automatic fallback, so
    // there is no carrier question and no self-hosting detour on ANY journey —
    // the daemon step leads straight to pairing. Running your own relay is an
    // expert runbook outside first run, not a step.
    const everyJourney: readonly OnboardingPath[] = [
      here(),
      here('add-daemon'),
      away('desktop'),
      away('mobile'),
      client('desktop'),
      client('mobile'),
    ];
    for (const path of everyJourney) {
      for (const gone of ['connect', 'relay-fingerprint', 'relay-source', 'relay-allow', 'relay-deploy']) {
        expect(onboardingRouteSteps(path)).not.toContain(gone as never);
      }
    }
    expect(nextOnboardingStep(here(), 'daemon')).toBe('local');
    for (const gone of ['connect', 'relay-fingerprint', 'relay-source', 'relay-allow', 'relay-deploy']) {
      expect(isOnboardingStepId(gone)).toBe(false);
    }
  });

  it('opens every journey on its own first step', () => {
    expect(firstOnboardingStep(here())).toBe('install');
    expect(firstOnboardingStep(away())).toBe('elsewhere');
    expect(firstOnboardingStep(away('desktop', 'add-daemon'))).toBe('elsewhere');
    expect(firstOnboardingStep(client())).toBe('scan');
    expect(firstOnboardingStep(here('add-daemon'))).toBe('install');
  });

  it('knows which steps belong to which journey', () => {
    expect(isStepOfRoute(here(), 'local')).toBe(true);
    // `local` is the same-machine collapse; neither a client nor a reader whose
    // daemon is on another machine walks it.
    expect(isStepOfRoute(client(), 'local')).toBe(false);
    expect(isStepOfRoute(away(), 'local')).toBe(false);
    expect(isStepOfRoute(here(), 'install')).toBe(true);
    expect(isStepOfRoute(away('desktop'), 'install')).toBe(false);
    expect(onboardingStepIndex(here(), 'local')).toBe(2);
    expect(onboardingStepIndex(client(), 'install')).toBe(-1);
  });

  it('clamps at both ends of a journey rather than falling off it', () => {
    expect(nextOnboardingStep(here(), 'install')).toBe('daemon');
    expect(nextOnboardingStep(here(), 'local')).toBe('local');
    expect(nextOnboardingStep(client(), 'scan')).toBe('scan');
    expect(nextOnboardingStep(away(), 'elsewhere')).toBe('scan');
    expect(previousOnboardingStep(here(), 'local')).toBe('daemon');
    expect(previousOnboardingStep(here(), 'daemon')).toBe('install');
    expect(previousOnboardingStep(client(), 'scan')).toBe('scan');
    expect(furthestOnboardingStep(here(), 'daemon', 'local')).toBe('local');
    expect(furthestOnboardingStep(here(), 'local', 'install')).toBe('local');
  });

  it('names where each journey PAIRS, which is its last step', () => {
    // Pairing is the last thing the daemonless half does: the setup flow takes over when the daemon answers.
    expect(pairingOnboardingStep(here())).toBe('local');
    expect(pairingOnboardingStep(here('add-daemon'))).toBe('local');
    expect(pairingOnboardingStep(away())).toBe('scan');
    expect(pairingOnboardingStep(client())).toBe('scan');
  });

  it('knows the last step of every journey, so nothing offers a way onward from it', () => {
    expect(isLastOnboardingStep(here(), 'local')).toBe(true);
    expect(isLastOnboardingStep(here(), 'daemon')).toBe(false);
    expect(isLastOnboardingStep(away(), 'scan')).toBe(true);
    expect(isLastOnboardingStep(away(), 'elsewhere')).toBe(false);
  });

  it('keeps a step reachable after the reader steps back from it', () => {
    const path = here();
    expect(onboardingStepStatus(path, 'install', 'install', 'local')).toBe('current');
    expect(onboardingStepStatus(path, 'daemon', 'install', 'local')).toBe('completed');
    // The furthest point is still somewhere they have been, so it stays jumpable.
    expect(onboardingStepStatus(path, 'local', 'install', 'local')).toBe('completed');
    expect(onboardingStepStatus(away(), 'scan', 'elsewhere', 'elsewhere')).toBe('upcoming');
  });

  it('names every step it can put on the glass, and nothing else', () => {
    expect(onboardingStep('daemon').title).toBe('Start the daemon');
    expect(onboardingStep('local').summary).toContain('nothing to scan');
    expect(onboardingStep('elsewhere').title).toBe('Open Ferretry on that computer');
    expect(isOnboardingStepId('local')).toBe(true);
    expect(isOnboardingStepId('elsewhere')).toBe(true);
    // The three r10 O5 removed: installing an agent, offering a phone, and the "you are set up" page.
    for (const gone of ['agents', 'handoff', 'done']) expect(isOnboardingStepId(gone)).toBe(false);
    // And the two C59 O7 removed with the agent journey: its prompt and its pairing.
    for (const gone of ['brief', 'agent-pair']) expect(isOnboardingStepId(gone)).toBe(false);
    // The step this replaced, whose subject was the wrong machine entirely.
    expect(isOnboardingStepId('need-computer')).toBe(false);
    expect(isOnboardingStepId('bribe')).toBe(false);
    expect(isOnboardingStepId(2)).toBe(false);
    expect(isOnboardingStepId(null)).toBe(false);
  });
});

describe('going back', () => {
  it('lands on the question that actually opened this journey', () => {
    // A daemon journey was opened by the target question when this device asked it; the pairing entry, and a daemon
    // journey whose machine was settled, were opened by the entry question itself.
    expect(questionBehindRoute('add-daemon', 'desktop')).toBe('target');
    expect(questionBehindRoute('first-time', 'desktop')).toBe('entry');
    expect(questionBehindRoute('first-time', 'mobile')).toBe('entry');
    expect(questionBehindRoute('add-daemon', 'mobile')).toBe('entry');
    expect(questionBehindRoute('add-client', 'desktop')).toBe('entry');
    expect(questionBehindRoute('add-client', 'mobile')).toBe('entry');
  });
});

describe('handing the setup to the other device', () => {
  it('sends a computer words and a phone a QR, decided by who RECEIVES', () => {
    // Nothing on a desk points a camera at another screen. Keying this off the
    // sender drew an unreadable QR whenever a laptop handed a server its setup.
    expect(handoffTarget(away('mobile'))).toEqual({
      receiver: 'computer',
      journey: { route: 'first-time', target: 'this' },
      step: 'install',
    });
    expect(handoffTarget(away('desktop', 'add-daemon'))).toEqual({
      receiver: 'computer',
      journey: { route: 'add-daemon', target: 'this' },
      step: 'install',
    });
    // A computer with a daemon has only membership to offer, and the phone needs
    // a code somebody must print — which at that moment is this computer.
    expect(handoffTarget(here())).toEqual({
      receiver: 'phone',
      journey: { route: 'add-client' },
      step: 'scan',
    });
    expect(handoffTarget(client())).toEqual({
      receiver: 'phone',
      journey: { route: 'add-client' },
      step: 'scan',
    });
  });

  it('tells the receiving computer to install on ITSELF, which is the recursion', () => {
    // One place teaches installation, and it is always teaching the machine the
    // reader is sitting at.
    const sent = handoffTarget(away('mobile'));
    expect(sent.journey.route === 'add-client' ? undefined : sent.journey.target).toBe('this');
    expect(isStepOfRoute({ ...sent.journey, device: 'desktop' }, sent.step)).toBe(true);
  });
});

describe('install channels', () => {
  it('shows every documented route, and only documented commands', () => {
    expect(INSTALL_CHANNELS.map(channel => channel.id)).toEqual(['apt', 'dnf', 'brew', 'nix', 'curl']);
    // Short enough to fit a phone row, and still naming the platform a reader
    // recognises their own machine as.
    expect(INSTALL_CHANNELS.map(channel => channel.label)).toEqual([
      'Debian / Ubuntu',
      'Fedora / RHEL',
      'macOS',
      'Nix',
      'Anything else (script)',
    ]);
    for (const channel of INSTALL_CHANNELS) {
      expect(installChannel(channel.id)).toBe(channel);
      // Character for character: a paraphrased install command is one nobody
      // has ever run. `cli-contracts.sh` pins the doc, so this pins the page.
      expect(installationDoc).toContain(channel.command);
    }
  });

  it('labels the script as the fallback, and labels nothing else that way', () => {
    // macOS has a first-class packaged route, so a reader on a Mac must never be
    // offered `curl … | bash` as an equal choice — the cask clears Gatekeeper.
    expect(installChannel('curl').fallback).toBe(true);
    expect(INSTALL_CHANNELS.filter(channel => channel.fallback === true).map(channel => channel.id)).toEqual(['curl']);
    expect(installChannel('brew').label).toBe('macOS');
    expect(installChannel('curl').label).toContain('else');
  });

  it('installs both executables through the flake, exactly as the flake builds them', () => {
    // The default package is a symlinkJoin of `fy` and `fyd`, so `nix profile
    // install` of the flake is one command for both. Pinned against the doc so
    // an unverified command cannot reach the page.
    expect(installChannel('nix').command).toBe('nix profile install github:kirinnee/ferretry');
    expect(installationDoc).toContain(installChannel('nix').command);
  });

  it('offers no Intel mac, because no release targets one', () => {
    expect(installChannel('brew').command).toContain('brew install --cask ferretry');
    expect(INSTALL_CHANNELS.map(channel => channel.label).join('|')).not.toContain('Intel');
  });

  it('pins the verification and daemon commands the CLI actually mounts', () => {
    expect(VERIFY_COMMAND).toBe('fy --version');
    expect(installationDoc).toContain(VERIFY_COMMAND);
    expect(DAEMON_START_COMMAND).toBe('fy daemon start');
    expect(DAEMON_INSTALL_COMMAND).toBe('fy daemon install');
    expect(DAEMON_STATUS_COMMAND).toBe('fy daemon status');
    expect(PAIR_COMMAND).toBe('fy pair');
    expect(PAIR_OPEN_COMMAND).toBe('fy pair --open');
    expect(DAEMON_SERVING_OUTPUT).toBe('fyd is serving');
  });

  it('guesses a route from the user agent and never guesses nothing', () => {
    expect(detectInstallChannel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('brew');
    expect(detectInstallChannel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('brew');
    expect(detectInstallChannel('Mozilla/5.0 (X11; Ubuntu; Linux x86_64)')).toBe('apt');
    expect(detectInstallChannel('Mozilla/5.0 (X11; Debian; Linux x86_64)')).toBe('apt');
    expect(detectInstallChannel('Mozilla/5.0 (X11; Fedora; Linux x86_64)')).toBe('dnf');
    expect(detectInstallChannel('Mozilla/5.0 (X11; CentOS; Linux x86_64)')).toBe('dnf');
    // Android, Windows and an absent agent all fall to the one installer that
    // works on every supported target rather than to nothing at all.
    expect(detectInstallChannel('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('curl');
    expect(detectInstallChannel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('curl');
    expect(detectInstallChannel(undefined)).toBe('curl');
  });
});

describe('the removed "let an agent do it" path (C59 O7)', () => {
  it('leaves no agent prompt, harness list or agent step in the model', async () => {
    const model = await Bun.file(new URL('../../../app/onboarding-model.ts', import.meta.url)).text();
    expect(model).not.toMatch(/agentSetupPrompt|AGENT_HARNESSES|OnboardingDoerId|agent-pair|'brief'/);
  });
});
