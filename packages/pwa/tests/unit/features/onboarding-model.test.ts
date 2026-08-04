/**
 * The setup screen's strings are a contract, not copy.
 *
 * Every command it shows is run by a stranger on a machine nobody here can see,
 * so the tests that matter are the ones that pin the text: against
 * `INSTALLATION.md` for the install routes, against `Taskfile.yaml` and
 * `wrangler.jsonc` for the relay ones, and against a list of things the agent
 * prompt must never contain, because that prompt ships inside a public bundle.
 *
 * The route tests exist for a different reason: three journeys mean three step
 * lists, and a step list that lets one route's step be reached from another is
 * how a reader ends up on a screen their journey never has.
 */

import { describe, expect, it } from 'bun:test';

import {
  AGENT_SETUP_PROMPT,
  DAEMON_INSTALL_COMMAND,
  DAEMON_SERVING_OUTPUT,
  DAEMON_START_COMMAND,
  DAEMON_STATUS_COMMAND,
  detectInstallChannel,
  firstOnboardingStep,
  furthestOnboardingStep,
  INSTALL_CHANNELS,
  installChannel,
  isOnboardingRouteId,
  isOnboardingStepId,
  isStepOfRoute,
  nextOnboardingStep,
  ONBOARDING_ROUTES,
  onboardingRoute,
  onboardingRouteSteps,
  onboardingStep,
  onboardingStepCount,
  onboardingStepIndex,
  onboardingStepStatus,
  PAIR_COMMAND,
  PAIR_PRINT_COMMAND,
  previousOnboardingStep,
  VERIFY_COMMAND,
} from '../../../src/features/onboarding/onboarding-model.ts';

const repoFile = async (path: string): Promise<string> =>
  await Bun.file(new URL(`../../../../../${path}`, import.meta.url)).text();

const installationDoc = await repoFile('INSTALLATION.md');

describe('the three entry paths', () => {
  it('offers exactly the three answers the reader was asked for', () => {
    expect(ONBOARDING_ROUTES.map(route => route.id)).toEqual(['have-link', 'first-time', 'agent']);
    for (const route of ONBOARDING_ROUTES) {
      expect(onboardingRoute(route.id)).toBe(route);
      // Every answer says what happens, in one line rather than a paragraph.
      expect(route.answer.length).toBeGreaterThan(0);
      expect(route.answer).not.toContain('\n');
    }
  });

  it('gives a reader holding a link nothing to install', () => {
    // The whole point of the shortest route: no install, no daemon, no carrier.
    expect(onboardingRouteSteps('have-link')).toEqual(['pair', 'done']);
    expect(onboardingStepCount('have-link')).toBe(2);
  });

  it('walks the full arc only on the first-time route, carrier choice included', () => {
    expect(onboardingRouteSteps('first-time')).toEqual(['install', 'daemon', 'connect', 'pair', 'done']);
    expect(onboardingStepCount('first-time')).toBe(5);
  });

  it('makes the agent path a route rather than an aside', () => {
    expect(onboardingRouteSteps('agent')).toEqual(['brief', 'pair', 'done']);
  });

  it('opens each route on its own first step', () => {
    expect(firstOnboardingStep('have-link')).toBe('pair');
    expect(firstOnboardingStep('first-time')).toBe('install');
    expect(firstOnboardingStep('agent')).toBe('brief');
  });

  it('knows which steps belong to which route', () => {
    expect(isStepOfRoute('first-time', 'connect')).toBe(true);
    // `connect` is a first-time decision; the other two routes never ask it.
    expect(isStepOfRoute('have-link', 'connect')).toBe(false);
    expect(isStepOfRoute('agent', 'install')).toBe(false);
    expect(onboardingStepIndex('first-time', 'pair')).toBe(3);
    expect(onboardingStepIndex('have-link', 'install')).toBe(-1);
  });

  it('clamps at both ends of a route rather than falling off it', () => {
    expect(nextOnboardingStep('first-time', 'install')).toBe('daemon');
    expect(nextOnboardingStep('first-time', 'connect')).toBe('pair');
    expect(nextOnboardingStep('agent', 'brief')).toBe('pair');
    expect(nextOnboardingStep('have-link', 'done')).toBe('done');
    expect(previousOnboardingStep('first-time', 'pair')).toBe('connect');
    expect(previousOnboardingStep('agent', 'brief')).toBe('brief');
    expect(furthestOnboardingStep('first-time', 'daemon', 'pair')).toBe('pair');
    expect(furthestOnboardingStep('first-time', 'done', 'install')).toBe('done');
  });

  it('keeps a step reachable after the reader steps back from it', () => {
    // Stepped back to install, having once reached pair.
    expect(onboardingStepStatus('first-time', 'install', 'install', 'pair')).toBe('current');
    expect(onboardingStepStatus('first-time', 'daemon', 'install', 'pair')).toBe('completed');
    // The furthest point is still somewhere they have been, so it stays jumpable.
    expect(onboardingStepStatus('first-time', 'pair', 'install', 'pair')).toBe('completed');
    expect(onboardingStepStatus('first-time', 'done', 'install', 'pair')).toBe('upcoming');
  });

  it('names every step it can put on the glass, and nothing else', () => {
    expect(onboardingStep('connect').title).toBe('How this reaches it');
    expect(onboardingStep('brief').short).toBe('Brief');
    expect(isOnboardingStepId('connect')).toBe(true);
    expect(isOnboardingStepId('finished')).toBe(false);
    expect(isOnboardingStepId(2)).toBe(false);
    expect(isOnboardingStepId(null)).toBe(false);
  });

  it('accepts only the three route ids back from storage', () => {
    expect(isOnboardingRouteId('have-link')).toBe(true);
    expect(isOnboardingRouteId('stepper')).toBe(false);
    expect(isOnboardingRouteId(1)).toBe(false);
    expect(isOnboardingRouteId(undefined)).toBe(false);
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
