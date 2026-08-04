/**
 * The setup screen's strings are a contract, not copy.
 *
 * Every command it shows is run by a stranger on a machine nobody here can see,
 * so the tests that matter are the ones that pin the text: against
 * `INSTALLATION.md` for the install routes, against `Taskfile.yaml` and
 * `wrangler.jsonc` for the relay ones, and against a list of things the agent
 * prompt must never contain, because that prompt ships inside a public bundle.
 *
 * The journey tests exist for a different reason: the step list is a function of
 * WHICH COMPUTER runs the daemon, WHO INSTALLS IT and WHAT THIS DEVICE IS, and the
 * mistakes it can make are all bad in a way coverage cannot see. Offering a phone
 * a step it cannot act on sends a reader to a screen full of commands with nowhere
 * to type them; making a desktop pair by scanning its own screen is the indignity
 * this rewrite exists to remove; and explaining an install on a machine the reader
 * is not sitting at is a second copy of the instructions that will go wrong. So
 * every combination is asserted, on both devices.
 */

import { describe, expect, it } from 'bun:test';

import {
  AGENT_HARNESSES,
  agentHarness,
  agentSetupPrompt,
  CONNECTION_METHODS,
  connectionMethod,
  DAEMON_INSTALL_COMMAND,
  DAEMON_SERVING_OUTPUT,
  DAEMON_START_COMMAND,
  DAEMON_STATUS_COMMAND,
  DEFAULT_CONNECTION_METHOD,
  detectInstallChannel,
  firstOnboardingStep,
  furthestOnboardingStep,
  handoffTarget,
  INSTALL_CHANNELS,
  installChannel,
  isConnectionMethodId,
  isDaemonRouteId,
  isLastOnboardingStep,
  isOnboardingDoerId,
  isOnboardingRouteId,
  isOnboardingStepId,
  isSetupTargetId,
  isStepOfRoute,
  isTargetPossible,
  journeyLabel,
  nextOnboardingStep,
  ONBOARDING_ROUTES,
  onboardingDoer,
  onboardingDoers,
  type OnboardingPath,
  onboardingRoute,
  onboardingRouteSteps,
  onboardingStep,
  onboardingStepCount,
  onboardingStepIndex,
  onboardingStepStatus,
  pairingOnboardingStep,
  PAIR_COMMAND,
  PAIR_OPEN_COMMAND,
  PAIR_PRINT_COMMAND,
  pathConnection,
  presumedTarget,
  previousOnboardingStep,
  questionBehindDoer,
  questionBehindRoute,
  SETUP_TARGETS,
  setupTarget,
  targetBasis,
  VERIFY_COMMAND,
} from '../../../src/features/onboarding/onboarding-model.ts';

const repoFile = async (path: string): Promise<string> =>
  await Bun.file(new URL(`../../../../../${path}`, import.meta.url)).text();

const installationDoc = await repoFile('INSTALLATION.md');

/** A daemon standing up on the machine reading the page, installed by hand. */
const here = (route: 'first-time' | 'add-daemon' = 'first-time', connection?: 'own-relay'): OnboardingPath => ({
  route,
  target: 'this',
  doer: 'self',
  device: 'desktop',
  ...(connection === undefined ? {} : { connection }),
});

/** The same by hand, but the daemon lives somewhere the reader has to walk to. */
const away = (device: 'desktop' | 'mobile' = 'mobile', route: 'first-time' | 'add-daemon' = 'first-time') =>
  ({ route, target: 'other', doer: 'self', device }) as OnboardingPath;

/** An agent doing it, on either machine. */
const byAgent = (target: 'this' | 'other', device: 'desktop' | 'mobile' = 'desktop'): OnboardingPath => ({
  route: 'first-time',
  target,
  doer: 'agent',
  device,
});

const client = (device: 'desktop' | 'mobile' = 'desktop'): OnboardingPath => ({ route: 'add-client', device });

describe('which computer runs the daemon', () => {
  it('offers two answers, this machine first, and says what each means', () => {
    expect(SETUP_TARGETS.map(target => target.id)).toEqual(['this', 'other']);
    for (const target of SETUP_TARGETS) {
      expect(setupTarget(target.id)).toBe(target);
      expect(target.answer).not.toContain('\n');
    }
    expect(setupTarget('this').title).toBe('This computer');
    expect(setupTarget('other').title).toBe('Another computer');
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

describe('who installs it', () => {
  it('offers two answers, agent first, worded for the machine already chosen', () => {
    for (const target of ['this', 'other'] as const) {
      expect(onboardingDoers(target).map(doer => doer.id)).toEqual(['agent', 'self']);
      for (const doer of onboardingDoers(target)) {
        expect(onboardingDoer(doer.id, target)).toBe(doer);
        expect(doer.answer).not.toContain('\n');
      }
    }
    // Concrete about the host, because pasting the prompt into an agent on the
    // wrong machine installs Ferretry on the wrong machine.
    expect(onboardingDoer('agent', 'this').answer).toContain('this computer');
    expect(onboardingDoer('agent', 'other').answer).toContain('that computer');
    expect(onboardingDoer('self', 'this').answer).toContain('terminal on this computer');
    expect(onboardingDoer('self', 'other').answer).toContain('Open Ferretry on that computer');
    // The default exists so a caller with only an id still gets a real answer.
    expect(onboardingDoer('self')).toBe(onboardingDoer('self', 'this'));
  });

  it('accepts only the two answers back from storage or a link', () => {
    expect(isOnboardingDoerId('agent')).toBe(true);
    expect(isOnboardingDoerId('self')).toBe(true);
    expect(isOnboardingDoerId('someone-else')).toBe(false);
    expect(isOnboardingDoerId(null)).toBe(false);
  });
});

describe('the agents Ferretry runs', () => {
  it('names both harnesses, with a command that installs and a command that only checks', () => {
    // Ferretry RUNS Claude Code and Codex; it is not either of them. With both
    // missing, the daemon starts perfectly and can run nothing at all.
    expect(AGENT_HARNESSES.map(harness => harness.id)).toEqual(['claude', 'codex']);
    for (const harness of AGENT_HARNESSES) {
      expect(agentHarness(harness.id)).toBe(harness);
      expect(harness.command).not.toContain('\n');
      // The check names the executable a fresh fleet manifest points at, and asks
      // it for nothing but its version.
      expect(harness.check).toBe(`${harness.id} --version`);
    }
    expect(agentHarness('claude').label).toBe('Claude Code');
    expect(agentHarness('codex').label).toBe('Codex');
  });

  it('installs each one the way its own documentation does, and nothing local', () => {
    // These belong to other people's products, so unlike `INSTALL_CHANNELS` no
    // contract in this repository can hold them to anything. What they must not do
    // is name a path, a wrapper or this machine.
    expect(agentHarness('claude').command).toBe('npm install -g @anthropic-ai/claude-code');
    expect(agentHarness('codex').command).toBe('npm install -g @openai/codex');
    for (const harness of AGENT_HARNESSES) {
      expect(harness.command).toContain('npm install -g');
      for (const local of ['$HOME', '~/', 'nix profile', 'sudo']) expect(harness.command).not.toContain(local);
    }
  });

  it('is a step on every by-hand journey, before the daemon that reports it', () => {
    // Not a fourth question — there is nothing here to decide — and not after the
    // daemon, which would tell the reader something was missing at the one moment
    // they were being congratulated for starting it.
    for (const path of [here(), here('add-daemon'), here('first-time', 'own-relay')]) {
      expect(onboardingRouteSteps(path)).toContain('agents');
      expect(onboardingStepIndex(path, 'agents')).toBeLessThan(onboardingStepIndex(path, 'daemon'));
      expect(onboardingStepIndex(path, 'install')).toBeLessThan(onboardingStepIndex(path, 'agents'));
    }
    // An agent doing the setup covers it inside the prompt instead, and a reader
    // whose daemon is elsewhere is not being taught anything about that machine.
    expect(onboardingRouteSteps(byAgent('this'))).not.toContain('agents');
    expect(onboardingRouteSteps(away())).not.toContain('agents');
    expect(onboardingRouteSteps(client())).not.toContain('agents');
  });

  it('says at least one is enough, and never promises it is signed in', () => {
    expect(onboardingStep('agents').title).toBe('Install Claude Code or Codex');
    expect(onboardingStep('agents').summary).toContain('One of them is enough');
    expect(onboardingStep('agents').short).toBe('Agents');
    expect(isOnboardingStepId('agents')).toBe(true);
  });
});

describe('the entry question', () => {
  it('asks what the reader HAS, and never what this device is', () => {
    expect(ONBOARDING_ROUTES.map(route => route.id)).toEqual(['first-time', 'add-client', 'add-daemon']);
    for (const route of ONBOARDING_ROUTES) {
      expect(onboardingRoute(route.id)).toBe(route);
      expect(route.answer).not.toContain('\n');
      expect(route.answer.length).toBeGreaterThan(0);
    }
    // The answer a reader holding a live code recognises instantly.
    expect(onboardingRoute('add-client').title).toBe('I have a link or QR');
    // And the one that no longer claims THIS machine becomes anything.
    expect(onboardingRoute('add-daemon').title).toBe('Add another daemon');
    expect(onboardingRoute('add-daemon').answer).not.toContain('This machine');
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
    // "I have a link or QR · step 1 of 3" describes what the reader was holding
    // rather than what they are doing.
    expect(journeyLabel(client())).toBe('Pair this browser');
    expect(journeyLabel(here())).toBe('Get a daemon running');
    expect(journeyLabel(here('add-daemon'))).toBe('Add another daemon');
  });
});

describe('the steps each set of answers walks', () => {
  it('collapses pairing when the daemon is on the machine reading the page', () => {
    // No `pair`, no `scan`: this browser IS a client of that daemon already.
    expect(onboardingRouteSteps(here('add-daemon'))).toEqual([
      'install',
      'agents',
      'daemon',
      'connect',
      'local',
      'done',
    ]);
    expect(onboardingRouteSteps(here('add-daemon'))).not.toContain('scan');
    expect(onboardingRouteSteps(here())).toEqual([
      'install',
      'agents',
      'daemon',
      'connect',
      'local',
      'handoff',
      'done',
    ]);
  });

  it('offers the phone afterwards only when the reader is standing at the daemon', () => {
    expect(onboardingRouteSteps(here())).toContain('handoff');
    expect(onboardingRouteSteps(here('add-daemon'))).not.toContain('handoff');
    expect(onboardingRouteSteps(away())).not.toContain('handoff');
  });

  it('spends ONE screen on a daemon that lives somewhere else, and teaches nothing there', () => {
    // The recursion: that computer opens this page and walks the list above,
    // answering "this one". A second copy of the install instructions written
    // about somebody else's keyboard is a copy that goes wrong.
    for (const device of ['desktop', 'mobile'] as const) {
      expect(onboardingRouteSteps(away(device))).toEqual(['elsewhere', 'scan', 'done']);
      expect(onboardingRouteSteps(away(device))).not.toContain('install');
      expect(onboardingRouteSteps(away(device, 'add-daemon'))).toEqual(['elsewhere', 'scan', 'done']);
    }
  });

  it('reads the same on a phone and on a computer, which is the point of that screen', () => {
    // `need-computer` existed only on a phone and its subject was this device's
    // unsuitability. A laptop standing up a home server reaches the same screen
    // and is not being refused anything.
    expect(onboardingRouteSteps(away('desktop'))).toEqual(onboardingRouteSteps(away('mobile')));
  });

  it('walks one agent journey wherever the reader is standing', () => {
    // No install to be impossible here, no platform to pick: the agent has the
    // terminal, and this browser only has to end up paired with the daemon.
    for (const target of ['this', 'other'] as const) {
      for (const device of ['desktop', 'mobile'] as const) {
        if (!isTargetPossible(target, device)) continue;
        expect(onboardingRouteSteps(byAgent(target, device))).toEqual(['brief', 'agent-pair', 'done']);
      }
    }
    expect(firstOnboardingStep(byAgent('this'))).toBe('brief');
    expect(onboardingStepCount(byAgent('other', 'mobile'))).toBe(3);
  });

  it('gives a reader who already has a daemon nothing to install', () => {
    for (const device of ['desktop', 'mobile'] as const) {
      expect(onboardingRouteSteps(client(device))).toEqual(['pair', 'scan', 'done']);
      expect(onboardingStepCount(client(device))).toBe(3);
    }
  });

  it('shows the self-host detour on the track rather than hiding it', () => {
    expect(onboardingRouteSteps(here('first-time', 'own-relay'))).toEqual([
      'install',
      'agents',
      'daemon',
      'connect',
      'relay-fingerprint',
      'relay-source',
      'relay-allow',
      'relay-deploy',
      'local',
      'handoff',
      'done',
    ]);
    expect(onboardingStepCount(here('first-time', 'own-relay'))).toBeGreaterThan(onboardingStepCount(here()));
  });

  it('reports a carrier answer only for a journey that has one', () => {
    expect(pathConnection(here('first-time', 'own-relay'))).toBe('own-relay');
    expect(pathConnection(here())).toBeUndefined();
    // The pairing entry is never asked, so it cannot report one either.
    expect(pathConnection(client())).toBeUndefined();
  });

  it('opens every journey on its own first step', () => {
    expect(firstOnboardingStep(here())).toBe('install');
    expect(firstOnboardingStep(away())).toBe('elsewhere');
    expect(firstOnboardingStep(away('desktop', 'add-daemon'))).toBe('elsewhere');
    expect(firstOnboardingStep(client())).toBe('pair');
    expect(firstOnboardingStep(here('add-daemon'))).toBe('install');
  });

  it('knows which steps belong to which journey', () => {
    expect(isStepOfRoute(here(), 'connect')).toBe(true);
    // `connect` is a daemon-side decision; a client never chooses a carrier, and
    // neither does a reader whose daemon is on another machine.
    expect(isStepOfRoute(client(), 'connect')).toBe(false);
    expect(isStepOfRoute(away(), 'connect')).toBe(false);
    expect(isStepOfRoute(here(), 'install')).toBe(true);
    expect(isStepOfRoute(away('desktop'), 'install')).toBe(false);
    expect(onboardingStepIndex(here(), 'local')).toBe(4);
    expect(onboardingStepIndex(here('first-time', 'own-relay'), 'relay-deploy')).toBe(7);
    expect(onboardingStepIndex(client(), 'install')).toBe(-1);
  });

  it('clamps at both ends of a journey rather than falling off it', () => {
    expect(nextOnboardingStep(here(), 'install')).toBe('agents');
    expect(nextOnboardingStep(here(), 'agents')).toBe('daemon');
    expect(nextOnboardingStep(here(), 'local')).toBe('handoff');
    expect(nextOnboardingStep(here('first-time', 'own-relay'), 'connect')).toBe('relay-fingerprint');
    expect(nextOnboardingStep(client(), 'done')).toBe('done');
    expect(nextOnboardingStep(away(), 'elsewhere')).toBe('scan');
    expect(previousOnboardingStep(here(), 'local')).toBe('connect');
    expect(previousOnboardingStep(here(), 'daemon')).toBe('agents');
    expect(previousOnboardingStep(here('first-time', 'own-relay'), 'local')).toBe('relay-deploy');
    expect(previousOnboardingStep(client(), 'pair')).toBe('pair');
    expect(furthestOnboardingStep(here(), 'daemon', 'local')).toBe('local');
    expect(furthestOnboardingStep(here(), 'done', 'install')).toBe('done');
  });

  it('names where each journey PAIRS, which is not the step before the end', () => {
    // The last screen offers a way back to pairing when nothing is paired. On the
    // journey that offers the reader's phone afterwards, the step before the end
    // is that optional offer — a screen with no pairing on it.
    expect(pairingOnboardingStep(here())).toBe('local');
    expect(pairingOnboardingStep(here('add-daemon'))).toBe('local');
    expect(pairingOnboardingStep(byAgent('this'))).toBe('agent-pair');
    expect(pairingOnboardingStep(away())).toBe('scan');
    expect(pairingOnboardingStep(client())).toBe('scan');
  });

  it('knows the last step of every journey, so nothing offers a way onward from it', () => {
    expect(isLastOnboardingStep(here(), 'done')).toBe(true);
    expect(isLastOnboardingStep(here(), 'handoff')).toBe(false);
    expect(isLastOnboardingStep(away(), 'done')).toBe(true);
    expect(isLastOnboardingStep(away(), 'elsewhere')).toBe(false);
  });

  it('keeps a step reachable after the reader steps back from it', () => {
    const path = here();
    expect(onboardingStepStatus(path, 'install', 'install', 'local')).toBe('current');
    expect(onboardingStepStatus(path, 'daemon', 'install', 'local')).toBe('completed');
    // The furthest point is still somewhere they have been, so it stays jumpable.
    expect(onboardingStepStatus(path, 'local', 'install', 'local')).toBe('completed');
    expect(onboardingStepStatus(path, 'done', 'install', 'local')).toBe('upcoming');
  });

  it('names every step it can put on the glass, and nothing else', () => {
    expect(onboardingStep('connect').title).toBe('Choose a connection');
    expect(onboardingStep('local').summary).toContain('nothing to scan');
    expect(onboardingStep('elsewhere').title).toBe('Open Ferretry on that computer');
    expect(onboardingStep('handoff').short).toBe('Phone');
    expect(onboardingStep('brief').title).toBe('Give your agent the prompt');
    expect(onboardingStep('agent-pair').short).toBe('Pair');
    expect(isOnboardingStepId('local')).toBe(true);
    expect(isOnboardingStepId('elsewhere')).toBe(true);
    // The step this replaced, whose subject was the wrong machine entirely.
    expect(isOnboardingStepId('need-computer')).toBe(false);
    expect(isOnboardingStepId('bribe')).toBe(false);
    expect(isOnboardingStepId(2)).toBe(false);
    expect(isOnboardingStepId(null)).toBe(false);
  });
});

describe('going back', () => {
  it('lands on the question that actually opened this journey', () => {
    // Every daemon journey was opened by answering who installs it; the pairing
    // entry was opened by the entry question itself.
    expect(questionBehindRoute('first-time')).toBe('doer');
    expect(questionBehindRoute('add-daemon')).toBe('doer');
    expect(questionBehindRoute('add-client')).toBe('entry');
  });

  it('skips the question this device never asked', () => {
    // A Back that lands on a question the reader never saw is the same defect as
    // one that skips the question they did answer.
    expect(questionBehindDoer('add-daemon', 'desktop')).toBe('target');
    expect(questionBehindDoer('first-time', 'desktop')).toBe('entry');
    expect(questionBehindDoer('first-time', 'mobile')).toBe('entry');
    expect(questionBehindDoer('add-daemon', 'mobile')).toBe('entry');
  });
});

describe('handing the setup to the other device', () => {
  it('sends a computer words and a phone a QR, decided by who RECEIVES', () => {
    // Nothing on a desk points a camera at another screen. Keying this off the
    // sender drew an unreadable QR whenever a laptop handed a server its setup.
    expect(handoffTarget(away('mobile'))).toEqual({
      receiver: 'computer',
      journey: { route: 'first-time', target: 'this', doer: 'self' },
      step: 'install',
    });
    expect(handoffTarget(away('desktop', 'add-daemon'))).toEqual({
      receiver: 'computer',
      journey: { route: 'add-daemon', target: 'this', doer: 'self' },
      step: 'install',
    });
    // A computer with a daemon has only membership to offer, and the phone needs
    // a code somebody must print — which at that moment is this computer.
    expect(handoffTarget(here())).toEqual({
      receiver: 'phone',
      journey: { route: 'add-client' },
      step: 'pair',
    });
    expect(handoffTarget(client())).toEqual({
      receiver: 'phone',
      journey: { route: 'add-client' },
      step: 'pair',
    });
  });

  it('tells the receiving computer to install BY HAND on ITSELF, which is the recursion', () => {
    // One place teaches installation, and it is always teaching the machine the
    // reader is sitting at.
    const sent = handoffTarget(away('mobile'));
    expect(sent.journey.route === 'add-client' ? undefined : sent.journey.target).toBe('this');
    expect(sent.journey.route === 'add-client' ? undefined : sent.journey.doer).toBe('self');
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
    expect(PAIR_PRINT_COMMAND).toBe('fy pair --no-wait');
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

describe('the connection chooser', () => {
  it('offers the three routes, with the default relay leading', () => {
    expect(CONNECTION_METHODS.map(method => method.id)).toEqual(['default-relay', 'own-relay', 'direct']);
    for (const method of CONNECTION_METHODS) {
      expect(connectionMethod(method.id)).toBe(method);
      expect(method.answer.length).toBeGreaterThan(0);
    }
    expect(DEFAULT_CONNECTION_METHOD).toBe('default-relay');
    expect(connectionMethod('default-relay').recommended).toBe(true);
  });

  it('keeps direct explicit without making it a preference setting', () => {
    const direct = connectionMethod('direct');
    expect(direct.title).toBe('Direct connection');
    expect(direct.answer).toContain('VPN');
  });

  it('makes self-hosting a longer route, not a hidden paragraph', () => {
    const own = connectionMethod('own-relay');
    expect(own.title).toContain('own relay');
    expect(onboardingStepCount(here('first-time', 'own-relay'))).toBeGreaterThan(onboardingStepCount(here()));
    expect(PAIR_PRINT_COMMAND).toBe('fy pair --no-wait');
  });

  it('accepts only the three connection ids back from storage', () => {
    expect(isConnectionMethodId('own-relay')).toBe(true);
    expect(isConnectionMethodId('tunnel')).toBe(false);
    expect(isConnectionMethodId(null)).toBe(false);
  });
});

describe('the agent setup prompt', () => {
  const both = [agentSetupPrompt('this'), agentSetupPrompt('other')];

  it('carries the same commands the page displays', () => {
    for (const prompt of both) {
      for (const channel of INSTALL_CHANNELS) {
        expect(prompt).toContain(channel.label);
        for (const line of channel.command.split('\n')) expect(prompt).toContain(line);
      }
      for (const command of [VERIFY_COMMAND, DAEMON_START_COMMAND, DAEMON_STATUS_COMMAND]) {
        expect(prompt).toContain(command);
      }
    }
  });

  it('tells the agent to stop and report rather than improvise', () => {
    for (const prompt of both) {
      expect(prompt).toContain('stop and report');
      expect(prompt).toContain('Do not improvise');
    }
  });

  it('names ONE pairing command, because the reader already answered where they are', () => {
    // It used to make the agent ASK whether the human was on this machine, since
    // it could not know and guessing spends a single-use code. The first question
    // settles that before an agent is offered at all.
    const onThisMachine = agentSetupPrompt('this');
    expect(onThisMachine).toContain(PAIR_OPEN_COMMAND);
    expect(onThisMachine).not.toContain('Ask me whether');
    // With the one fallback that is not hedging: a headless host cannot launch a
    // browser, and an agent that hits that with no instructions stops dead.
    expect(onThisMachine).toContain('cannot open a browser');
    expect(onThisMachine).toContain(PAIR_COMMAND);

    const fromElsewhere = agentSetupPrompt('other');
    expect(fromElsewhere).toContain(PAIR_COMMAND);
    expect(fromElsewhere).not.toContain(PAIR_OPEN_COMMAND);
    expect(fromElsewhere).toContain('the QR code and the pairing link');
    expect(fromElsewhere).toContain('single-use');
  });

  it('makes the agent CONFIRM a harness rather than assume one, on either target', () => {
    // The prompt is pasted INTO Claude or Codex, so one is there by definition —
    // which is exactly why this says confirm. An agent told "install a harness"
    // either installs a second one nobody asked for or skips the step as obviously
    // fine, and neither answer tells the human anything.
    for (const prompt of both) {
      expect(prompt).toContain('CHECK rather than assume');
      for (const harness of AGENT_HARNESSES) {
        expect(prompt).toContain(harness.check);
        expect(prompt).toContain(harness.command);
        expect(prompt).toContain(harness.label);
      }
      // At least one, never both.
      expect(prompt).toContain('If at least one answers');
      expect(prompt).toContain('install exactly one of these');
      // And it happens before the daemon boots, so the daemon's own report at boot
      // is about a machine that can already run something.
      expect(prompt.indexOf('CHECK rather than assume')).toBeLessThan(prompt.indexOf(DAEMON_START_COMMAND));
    }
  });

  it('refuses to sign anybody in, and says a version is not an account', () => {
    // A version string proves an executable exists. An agent that tried to
    // authenticate on the reader's behalf would be doing the one thing on this
    // page nobody delegated to it.
    for (const prompt of both) {
      expect(prompt).toContain('Being on PATH is not being signed in');
      expect(prompt).toContain('instead of attempting it');
    }
  });

  it('is self-contained: it says what Ferretry is before asking for anything', () => {
    // The agent may know nothing about this project and must not have to browse
    // documentation to follow it.
    for (const prompt of both) {
      expect(prompt).toContain('Ferretry is a CLI');
      expect(prompt).toContain('Detect the operating system and CPU architecture');
      expect(prompt).toContain('Linux amd64');
    }
  });

  it('says nothing about the person holding the page', () => {
    // The bundle is public: anyone can fetch this string. It must describe a
    // stranger's machine and no one's fleet.
    const forbidden = [
      'localhost',
      '127.0.0.1',
      'FY_TOKEN',
      'api-token',
      'daemonId',
      'deviceToken',
      'ferretry.pages.dev',
      '$HOME',
      '~/.ferretry',
    ];
    for (const prompt of both) {
      for (const secret of forbidden) expect(prompt).not.toContain(secret);
      // No absolute URL beyond the documented package sources.
      const urls = prompt.match(/https?:\/\/[^\s"']+/g) ?? [];
      for (const url of urls) expect(installationDoc).toContain(url);
    }
  });
});
