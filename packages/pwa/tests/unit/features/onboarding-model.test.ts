/**
 * The setup screen's strings are a contract, not copy.
 *
 * Every command it shows is run by a stranger on a machine nobody here can
 * see, so the tests that matter are the ones that pin the text: against
 * `INSTALLATION.md` for the install routes, and against a list of things the
 * agent prompt must never contain, because that prompt ships inside a public
 * bundle.
 */

import { describe, expect, it } from 'bun:test';

import {
  AGENT_SETUP_PROMPT,
  DAEMON_SERVING_OUTPUT,
  DAEMON_START_COMMAND,
  DAEMON_STATUS_COMMAND,
  detectInstallChannel,
  INSTALL_CHANNELS,
  installChannel,
  isOnboardingStepId,
  furthestOnboardingStep,
  nextOnboardingStep,
  ONBOARDING_STEP_COUNT,
  ONBOARDING_STEPS,
  onboardingStep,
  onboardingStepIndex,
  onboardingStepStatus,
  PAIR_COMMAND,
  previousOnboardingStep,
  VERIFY_COMMAND,
} from '../../../src/features/onboarding/onboarding-model.ts';

const installationDoc = await Bun.file(new URL('../../../../../INSTALLATION.md', import.meta.url)).text();

describe('the onboarding arc', () => {
  it('runs install to done, and clamps rather than falling off either end', () => {
    expect(ONBOARDING_STEPS.map(step => step.id)).toEqual(['install', 'daemon', 'pair', 'done']);
    expect(ONBOARDING_STEP_COUNT).toBe(4);
    expect(onboardingStep('daemon').title).toBe('Start the daemon');
    expect(onboardingStepIndex('pair')).toBe(2);

    expect(nextOnboardingStep('install')).toBe('daemon');
    expect(nextOnboardingStep('done')).toBe('done');
    expect(previousOnboardingStep('pair')).toBe('daemon');
    expect(previousOnboardingStep('install')).toBe('install');
    expect(furthestOnboardingStep('daemon', 'pair')).toBe('pair');
    expect(furthestOnboardingStep('done', 'install')).toBe('done');
  });

  it('keeps a step reachable after the reader steps back from it', () => {
    // Stepped back to install, having once reached pair.
    expect(onboardingStepStatus('install', 'install', 'pair')).toBe('current');
    expect(onboardingStepStatus('daemon', 'install', 'pair')).toBe('completed');
    // The furthest point is still somewhere they have been, so it stays jumpable.
    expect(onboardingStepStatus('pair', 'install', 'pair')).toBe('completed');
    expect(onboardingStepStatus('done', 'install', 'pair')).toBe('upcoming');
  });

  it('accepts only the four step ids back from storage', () => {
    expect(isOnboardingStepId('pair')).toBe(true);
    expect(isOnboardingStepId('finished')).toBe(false);
    expect(isOnboardingStepId(2)).toBe(false);
    expect(isOnboardingStepId(null)).toBe(false);
  });
});

describe('install channels', () => {
  it('shows every documented route, and only documented commands', () => {
    expect(INSTALL_CHANNELS.map(channel => channel.id)).toEqual(['apt', 'dnf', 'brew', 'curl']);
    // Short enough that four of them fit one phone row, and still naming the
    // platform a reader recognises their own machine as.
    expect(INSTALL_CHANNELS.map(channel => channel.label)).toEqual([
      'Debian / Ubuntu',
      'Fedora / RHEL',
      'macOS',
      'Linux / macOS',
    ]);
    for (const channel of INSTALL_CHANNELS) {
      expect(installChannel(channel.id)).toBe(channel);
      // Character for character: a paraphrased install command is one nobody
      // has ever run. `cli-contracts.sh` pins the doc, so this pins the page.
      expect(installationDoc).toContain(channel.command);
    }
  });

  it('offers no Intel mac, because no release targets one', () => {
    expect(installChannel('brew').command).toContain('brew install --cask ferretry');
    expect(INSTALL_CHANNELS.map(channel => channel.label).join('|')).not.toContain('Intel');
  });

  it('pins the verification and daemon commands the CLI actually mounts', () => {
    expect(VERIFY_COMMAND).toBe('fy --version');
    expect(installationDoc).toContain(VERIFY_COMMAND);
    expect(DAEMON_START_COMMAND).toBe('fy daemon start');
    expect(DAEMON_STATUS_COMMAND).toBe('fy daemon status');
    expect(PAIR_COMMAND).toBe('fy pair');
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
