/**
 * The setup screen's strings are a contract, not copy.
 *
 * Every command it shows is run by a stranger on a machine nobody here can see,
 * so the tests that matter are the ones that pin the text: against
 * `INSTALLATION.md` for the install routes, against `Taskfile.yaml` and
 * `wrangler.jsonc` for the relay ones, and against a list of things the agent
 * prompt must never contain, because that prompt ships inside a public bundle.
 *
 * The route tests exist for a different reason: the step list is a function of
 * the ROUTE AND THE DEVICE, and the two mistakes it can make are both bad in a
 * way coverage cannot see. Offering a phone a step it cannot act on sends a
 * reader to a screen full of commands with nowhere to type them; making a
 * desktop pair by scanning its own screen is the indignity this rewrite exists
 * to remove. So both devices are asserted for every route.
 */

import { describe, expect, it } from 'bun:test';

import {
  AGENT_SETUP_PROMPT,
  CONNECTION_METHODS,
  connectionMethod,
  DAEMON_INSTALL_COMMAND,
  DAEMON_SERVING_OUTPUT,
  DAEMON_START_COMMAND,
  DAEMON_STATUS_COMMAND,
  DEFAULT_CONNECTION_METHOD,
  detectInstallChannel,
  doerRoute,
  firstOnboardingStep,
  furthestOnboardingStep,
  handoffTarget,
  INSTALL_CHANNELS,
  installChannel,
  isConnectionMethodId,
  isLastOnboardingStep,
  isOnboardingDoerId,
  isOnboardingRouteId,
  isOnboardingStepId,
  isStepOfRoute,
  nextOnboardingStep,
  ONBOARDING_DOERS,
  onboardingDoer,
  type OnboardingPath,
  onboardingRoute,
  onboardingRoutes,
  onboardingRouteSteps,
  onboardingStep,
  onboardingStepCount,
  onboardingStepIndex,
  onboardingStepStatus,
  PAIR_COMMAND,
  PAIR_OPEN_COMMAND,
  PAIR_PRINT_COMMAND,
  previousOnboardingStep,
  questionBehindRoute,
  VERIFY_COMMAND,
} from '../../../src/features/onboarding/onboarding-model.ts';

const repoFile = async (path: string): Promise<string> =>
  await Bun.file(new URL(`../../../../../${path}`, import.meta.url)).text();

const installationDoc = await repoFile('INSTALLATION.md');

const desktop = (route: OnboardingPath['route'], connection?: OnboardingPath['connection']): OnboardingPath => ({
  route,
  device: 'desktop',
  connection,
});

const mobile = (route: OnboardingPath['route']): OnboardingPath => ({ route, device: 'mobile' });

describe('the first question — who does the work', () => {
  it('offers two answers, agent first, and both say where the work happens', () => {
    expect(ONBOARDING_DOERS.map(doer => doer.id)).toEqual(['agent', 'self']);
    for (const doer of ONBOARDING_DOERS) {
      expect(onboardingDoer(doer.id)).toBe(doer);
      // One line each, and each one names the machine rather than "this device":
      // a reader who pastes the prompt into the wrong terminal gets nothing.
      expect(doer.answer).not.toContain('\n');
      expect(doer.answer).toContain('machine that will run your agents');
    }
  });

  it('accepts only the two answers back from storage or a link', () => {
    expect(isOnboardingDoerId('agent')).toBe(true);
    expect(isOnboardingDoerId('self')).toBe(true);
    expect(isOnboardingDoerId('someone-else')).toBe(false);
    expect(isOnboardingDoerId(null)).toBe(false);
  });

  it('turns only the agent answer into a route, because the other one asks a second question', () => {
    expect(doerRoute('agent')).toBe('agent');
    expect(doerRoute('self')).toBeUndefined();
  });

  it('walks one journey on every device, because none of it happens on this one', () => {
    // No install to be impossible here, no platform to pick, nothing about this
    // device left to decide: the agent has the terminal, somewhere else.
    for (const device of ['desktop', 'mobile'] as const) {
      expect(onboardingRouteSteps({ route: 'agent', device })).toEqual(['brief', 'agent-pair', 'done']);
    }
    expect(firstOnboardingStep(desktop('agent'))).toBe('brief');
    // The connection chooser is a daemon-side decision the agent never surfaces.
    expect(onboardingRouteSteps(desktop('agent', 'own-relay'))).toEqual(['brief', 'agent-pair', 'done']);
    expect(onboardingStepCount(desktop('agent'))).toBe(3);
  });

  it('sends Back to the question that actually opened each route', () => {
    // The agent route was opened by the FIRST question; the three device answers
    // were opened one question later. Landing on a question the reader never
    // answered is how two questions start feeling like a maze.
    expect(questionBehindRoute('agent')).toBe('who');
    for (const route of ['first-time', 'add-client', 'add-daemon'] as const) {
      expect(questionBehindRoute(route)).toBe('choose');
    }
  });

  it('names the agent route on the glass without offering it as a device answer', () => {
    expect(onboardingRoute('agent').title).toBe('An agent sets it up');
    expect(onboardingRoutes('desktop').map(route => route.id)).not.toContain('agent');
    expect(onboardingRoutes('mobile').map(route => route.id)).not.toContain('agent');
  });

  it('names the two agent steps in words that say where the work is', () => {
    expect(onboardingStep('brief').title).toBe('Give your agent the prompt');
    expect(onboardingStep('brief').summary).toContain('that machine');
    expect(onboardingStep('agent-pair').short).toBe('Pair');
  });
});

describe('the three answers', () => {
  it('asks what the device is, not what the reader is holding', () => {
    expect(onboardingRoutes('desktop').map(route => route.id)).toEqual(['first-time', 'add-client', 'add-daemon']);
    for (const route of onboardingRoutes('desktop')) {
      expect(onboardingRoute(route.id)).toBe(route);
      // Every answer says what happens, in one line rather than a paragraph.
      expect(route.answer.length).toBeGreaterThan(0);
      expect(route.answer).not.toContain('\n');
    }
  });

  it('offers a phone the daemon answer, and tells it the truth about it', () => {
    const [, , daemonAnswer] = onboardingRoutes('mobile');
    // Still THREE answers: an option that vanishes reads as a broken page.
    expect(onboardingRoutes('mobile').map(route => route.id)).toEqual(['first-time', 'add-client', 'add-daemon']);
    expect(daemonAnswer?.answer).toContain('computer');
    // And it is not the desktop wording pretending this device can host one.
    expect(daemonAnswer).not.toBe(onboardingRoute('add-daemon', 'desktop'));
    expect(onboardingRoute('add-daemon', 'desktop').answer).toContain('terminal');
  });

  it('collapses pairing when the daemon is on the machine reading the page', () => {
    // No `pair`, no `scan`: this browser IS a client of that daemon already.
    expect(onboardingRouteSteps(desktop('add-daemon'))).toEqual(['install', 'daemon', 'connect', 'local', 'done']);
    expect(onboardingRouteSteps(desktop('add-daemon'))).not.toContain('scan');
    expect(onboardingRouteSteps(desktop('first-time'))).toEqual([
      'install',
      'daemon',
      'connect',
      'local',
      'handoff',
      'done',
    ]);
  });

  it('makes first-time setup the only route that spans two devices', () => {
    // Only first-time offers the phone afterwards; adding one more daemon does not.
    expect(onboardingRouteSteps(desktop('first-time'))).toContain('handoff');
    expect(onboardingRouteSteps(desktop('add-daemon'))).not.toContain('handoff');
    // And on a phone it is the route that hands the daemon half away, then waits.
    expect(onboardingRouteSteps(mobile('first-time'))).toEqual(['need-computer', 'scan', 'done']);
  });

  it('refuses to start a daemon on a phone rather than pretending to', () => {
    // One honest screen. A `Next` that advanced to itself would read as stuck.
    expect(onboardingRouteSteps(mobile('add-daemon'))).toEqual(['need-computer']);
    expect(isLastOnboardingStep(mobile('add-daemon'), 'need-computer')).toBe(true);
    expect(onboardingRouteSteps(mobile('add-daemon'))).not.toContain('install');
  });

  it('gives a reader who already has a daemon nothing to install', () => {
    for (const device of ['desktop', 'mobile'] as const) {
      expect(onboardingRouteSteps({ route: 'add-client', device })).toEqual(['pair', 'scan', 'done']);
      expect(onboardingStepCount({ route: 'add-client', device })).toBe(3);
    }
  });

  it('shows the self-host detour on the track rather than hiding it', () => {
    expect(onboardingRouteSteps(desktop('first-time', 'own-relay'))).toEqual([
      'install',
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
    expect(onboardingStepCount(desktop('first-time', 'own-relay'))).toBeGreaterThan(
      onboardingStepCount(desktop('first-time')),
    );
    // The relay detour is a desktop-only decision: a phone never reaches `connect`.
    expect(onboardingRouteSteps({ route: 'first-time', device: 'mobile', connection: 'own-relay' })).toEqual([
      'need-computer',
      'scan',
      'done',
    ]);
  });

  it('opens each route on its own first step, per device', () => {
    expect(firstOnboardingStep(desktop('first-time'))).toBe('install');
    expect(firstOnboardingStep(mobile('first-time'))).toBe('need-computer');
    expect(firstOnboardingStep(desktop('add-client'))).toBe('pair');
    expect(firstOnboardingStep(desktop('add-daemon'))).toBe('install');
    expect(firstOnboardingStep(mobile('add-daemon'))).toBe('need-computer');
  });

  it('knows which steps belong to which route on which device', () => {
    expect(isStepOfRoute(desktop('first-time'), 'connect')).toBe(true);
    // `connect` is a daemon-side decision; a client never chooses a carrier.
    expect(isStepOfRoute(desktop('add-client'), 'connect')).toBe(false);
    // The same route, the same step, a different answer — because of the device.
    expect(isStepOfRoute(desktop('first-time'), 'install')).toBe(true);
    expect(isStepOfRoute(mobile('first-time'), 'install')).toBe(false);
    expect(onboardingStepIndex(desktop('first-time'), 'local')).toBe(3);
    expect(onboardingStepIndex(desktop('first-time', 'own-relay'), 'relay-deploy')).toBe(6);
    expect(onboardingStepIndex(desktop('add-client'), 'install')).toBe(-1);
  });

  it('clamps at both ends of a route rather than falling off it', () => {
    expect(nextOnboardingStep(desktop('first-time'), 'install')).toBe('daemon');
    expect(nextOnboardingStep(desktop('first-time'), 'local')).toBe('handoff');
    expect(nextOnboardingStep(desktop('first-time', 'own-relay'), 'connect')).toBe('relay-fingerprint');
    expect(nextOnboardingStep(desktop('add-client'), 'done')).toBe('done');
    expect(nextOnboardingStep(mobile('add-daemon'), 'need-computer')).toBe('need-computer');
    expect(previousOnboardingStep(desktop('first-time'), 'local')).toBe('connect');
    expect(previousOnboardingStep(desktop('first-time', 'own-relay'), 'local')).toBe('relay-deploy');
    expect(previousOnboardingStep(desktop('add-client'), 'pair')).toBe('pair');
    expect(furthestOnboardingStep(desktop('first-time'), 'daemon', 'local')).toBe('local');
    expect(furthestOnboardingStep(desktop('first-time'), 'done', 'install')).toBe('done');
  });

  it('knows the last step of every route, so nothing offers a way onward from it', () => {
    expect(isLastOnboardingStep(desktop('first-time'), 'done')).toBe(true);
    expect(isLastOnboardingStep(desktop('first-time'), 'handoff')).toBe(false);
    expect(isLastOnboardingStep(mobile('first-time'), 'done')).toBe(true);
  });

  it('keeps a step reachable after the reader steps back from it', () => {
    const path = desktop('first-time');
    expect(onboardingStepStatus(path, 'install', 'install', 'local')).toBe('current');
    expect(onboardingStepStatus(path, 'daemon', 'install', 'local')).toBe('completed');
    // The furthest point is still somewhere they have been, so it stays jumpable.
    expect(onboardingStepStatus(path, 'local', 'install', 'local')).toBe('completed');
    expect(onboardingStepStatus(path, 'done', 'install', 'local')).toBe('upcoming');
  });

  it('sends a hand-off to the half the other device can actually do', () => {
    // A phone cannot install anything, so it hands the whole journey to a computer.
    expect(handoffTarget(mobile('first-time'))).toEqual({ route: 'first-time', step: 'install' });
    // A computer with a daemon has only membership to offer, and the phone needs a code.
    expect(handoffTarget(desktop('first-time'))).toEqual({ route: 'add-client', step: 'pair' });
  });

  it('names every step it can put on the glass, and nothing else', () => {
    expect(onboardingStep('connect').title).toBe('Choose a connection');
    expect(onboardingStep('local').summary).toContain('nothing to scan');
    expect(onboardingStep('need-computer').title).toBe('You will need a computer');
    expect(onboardingStep('handoff').short).toBe('Phone');
    expect(isOnboardingStepId('local')).toBe(true);
    // The agent route's two steps are real places now, not the names of a
    // journey that was deleted.
    expect(isOnboardingStepId('brief')).toBe(true);
    expect(isOnboardingStepId('agent-pair')).toBe(true);
    expect(isOnboardingStepId('bribe')).toBe(false);
    expect(isOnboardingStepId(2)).toBe(false);
    expect(isOnboardingStepId(null)).toBe(false);
  });

  it('accepts only the four route ids back from storage', () => {
    expect(isOnboardingRouteId('add-daemon')).toBe(true);
    // Not one of the device answers, but a route a stored place can name.
    expect(isOnboardingRouteId('agent')).toBe(true);
    // The route this replaced. A stored `have-link` describes a journey that is gone.
    expect(isOnboardingRouteId('have-link')).toBe(false);
    expect(isOnboardingRouteId(1)).toBe(false);
    expect(isOnboardingRouteId(undefined)).toBe(false);
  });

  it('accepts only the three connection ids back from storage', () => {
    expect(isConnectionMethodId('own-relay')).toBe(true);
    expect(isConnectionMethodId('tunnel')).toBe(false);
    expect(isConnectionMethodId(null)).toBe(false);
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
    expect(onboardingStepCount({ route: 'first-time', device: 'desktop', connection: 'own-relay' })).toBeGreaterThan(
      onboardingStepCount({ route: 'first-time', device: 'desktop' }),
    );
    expect(PAIR_PRINT_COMMAND).toBe('fy pair --no-wait');
  });
});

describe('the agent setup prompt', () => {
  it('carries the same commands the page displays', () => {
    for (const channel of INSTALL_CHANNELS) {
      expect(AGENT_SETUP_PROMPT).toContain(channel.label);
      for (const line of channel.command.split('\n')) expect(AGENT_SETUP_PROMPT).toContain(line);
    }
    for (const command of [VERIFY_COMMAND, DAEMON_START_COMMAND, DAEMON_STATUS_COMMAND, PAIR_COMMAND]) {
      expect(AGENT_SETUP_PROMPT).toContain(command);
    }
  });

  it('tells the agent to stop and report rather than improvise', () => {
    expect(AGENT_SETUP_PROMPT).toContain('stop and report');
    expect(AGENT_SETUP_PROMPT).toContain('Do not improvise');
  });

  it('tells the agent HOW TO REPORT BACK, both ways, and to ask which', () => {
    // Without this the person who pasted it is left wondering whether anything
    // worked. Which report is right depends on where they are reading the page,
    // the agent cannot know, and guessing spends a single-use code.
    expect(AGENT_SETUP_PROMPT).toContain('Ask me whether I am reading the Ferretry setup page');
    expect(AGENT_SETUP_PROMPT).toContain(PAIR_OPEN_COMMAND);
    expect(AGENT_SETUP_PROMPT).toContain('show me the QR code and the');
    expect(AGENT_SETUP_PROMPT).toContain('single-use');
    expect(AGENT_SETUP_PROMPT).toContain('Do not guess');
  });

  it('is self-contained: it says what Ferretry is before asking for anything', () => {
    // The agent may know nothing about this project and must not have to browse
    // documentation to follow it.
    expect(AGENT_SETUP_PROMPT).toContain('Ferretry is a CLI');
    expect(AGENT_SETUP_PROMPT).toContain('Detect the operating system and CPU architecture');
    expect(AGENT_SETUP_PROMPT).toContain('Linux amd64');
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
    for (const secret of forbidden) expect(AGENT_SETUP_PROMPT).not.toContain(secret);
    // No absolute URL beyond the documented package sources.
    const urls = AGENT_SETUP_PROMPT.match(/https?:\/\/[^\s"']+/g) ?? [];
    for (const url of urls) expect(installationDoc).toContain(url);
  });
});
