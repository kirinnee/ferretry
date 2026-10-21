/**
 * What an agent runtime's Claude wrapper relies on at launch (design §8.4, §8.5 Claude 4–5, G8).
 *
 * Each claim is read off the real first screen in a pseudo-terminal, beside the control that shows
 * the screen it suppresses, because "no trust prompt appeared" means nothing unless the prompt
 * appears without the key:
 *
 * - `hasCompletedOnboarding` and `projects[<cwd>].hasTrustDialogAccepted` in the config dir's
 *   `.claude.json` (INFERRED key names, so pinned only here) skip onboarding and the trust prompt.
 * - `--permission-mode auto` and `bypassPermissions` are accepted (O4).
 * - `--settings <file>` is an OVERLAY: a key only it carries takes effect, and a key only the config
 *   dir's own `settings.json` carries still does — the fixed layer adds to, never replaces, the file.
 * - The one-shot "Make auto mode your default permission mode?" dialog parks a runtime whose USER
 *   `settings.json` names a non-auto mode; `hasSeenAutoDefaultNudge` in `.claude.json`, or the same mode
 *   named by the `--settings` overlay, each keeps it away.
 *
 * - Remote Control at startup: a user `settings.json` carrying `remoteControlAtStartup: true` makes the
 *   session attempt the Remote Control bridge (the debug log's `[bridge:` lines); the same key set false
 *   in the `--settings` overlay keeps it away. `--rc` itself is not observable here, because a fake
 *   credential has no organisation and claude says "--rc flag ignored".
 *
 * The credential is a fake in a shared store and every request dies at the recording proxy, so the
 * session never gets further than its first screen.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { claudeCredential, screenOf } from './support/fixtures.ts';
import { harnessEnv, requireHarness, run, type Sandbox, sandbox } from './support/harness.ts';
import { claudeCredentialPlantable, plantClaudeCredential, removePlantedKeychainItems } from './support/keychain.ts';
import { type RecordingProxy, startProxy } from './support/network.ts';

const ONBOARDING = /Welcome to Claude Code|Choose the text style/;
const TRUST = /Quick safety check|trust this folder/;
/** How long a session gets to attempt the Remote Control bridge; it does so within a second of the first screen. */
const BRIDGE_WAIT_MS = 12_000;
const BRIDGE_TEST_MS = 30_000;
/** The input footer: "? for shortcuts" until 2.1.2xx, the permission-mode line once auto became the default. */
const PROMPT = /\? for shortcuts|shift\+tab to cycle/;
const BYPASS_WARNING = /Bypass Permissions mode/;
const BYPASS_ON = /bypass permissions on/;
const AUTO_ON = /auto mode on/;
const SETTLED = [ONBOARDING, TRUST, PROMPT, BYPASS_WARNING];
/** The one-shot "Make auto mode your default permission mode?" dialog (shouldShowAutoDefaultNudge). */
const AUTO_NUDGE = /Make auto mode your default permission mode/;
/**
 * The nudge is rolled out behind a remote flag, which a session that cannot reach the flag service
 * reads from the flag cache in `.claude.json`. Planting it there turns the dialog ON, so the control
 * below shows what the fixed layer suppresses.
 */
const NUDGE_FLAG = { cachedGrowthBookFeatures: { tengu_maple_pier: true } };
/** The flag cache is read only when the flag client is on, which non-essential traffic being off turns off. */
const NUDGE_ENV = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '' };

describe.skipIf(!claudeCredentialPlantable)('claude contract: launching an agent runtime', () => {
  let box: Sandbox;
  let proxy: RecordingProxy;
  let counter = 0;
  const claude = () => requireHarness('claude');

  beforeAll(async () => {
    box = await sandbox('claude-launch');
    proxy = startProxy();
  });
  afterAll(async () => {
    await removePlantedKeychainItems();
    proxy.stop();
    await box.dispose();
  });

  /** A runtime: a config dir, a shared store holding a fresh fake credential, and a working folder. */
  const runtime = async (
    options: {
      onboarded?: boolean;
      trusted?: boolean;
      settings?: Record<string, unknown>;
      state?: Record<string, unknown>;
      env?: Record<string, string>;
    } = {},
  ) => {
    counter++;
    const root = box.dir(`r${counter}`);
    const config = path.join(root, 'config');
    const store = path.join(root, 'store');
    const work = path.join(root, 'work');
    const home = path.join(root, 'home');
    for (const directory of [config, store, work, home]) await mkdir(directory, { recursive: true });
    await plantClaudeCredential(store, claudeCredential({ expired: false }));
    // Claude keys a project by the path it resolves, which on macOS is under /private.
    const cwd = await realpath(work);
    const state: Record<string, unknown> = {};
    if (options.onboarded === true) state.hasCompletedOnboarding = true;
    if (options.trusted === true) state.projects = { [cwd]: { hasTrustDialogAccepted: true } };
    Object.assign(state, options.state ?? {});
    if (Object.keys(state).length > 0) await writeFile(path.join(config, '.claude.json'), JSON.stringify(state));
    if (options.settings !== undefined)
      await writeFile(path.join(config, 'settings.json'), JSON.stringify(options.settings));
    const env = harnessEnv(home, proxy.port, {
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: store,
      ...options.env,
    });
    const overlay = async (document: Record<string, unknown>) => {
      const file = path.join(root, 'fixed.json');
      await writeFile(file, JSON.stringify(document));
      return file;
    };
    const screen = (args: string[], settled: readonly RegExp[] = SETTLED, timeoutMs?: number) =>
      screenOf([claude().bin, ...args], { env, cwd, settled, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    /** Starts claude with a debug log and returns the `[bridge:` lines it wrote: the Remote Control bridge's attempts. */
    const bridgeLog = async (args: string[]) => {
      const log = path.join(root, 'debug.log');
      await screen([...args, '--debug-file', log], [/NEVER_SETTLES/], BRIDGE_WAIT_MS).catch(() => '');
      const text = await Bun.file(log)
        .text()
        .catch(() => '');
      return text.split('\n').filter(line => line.includes('[bridge:'));
    };
    return { screen, overlay, bridgeLog, env, cwd };
  };

  it('shows onboarding to a config dir with neither key (the control)', async () => {
    const screen = await (await runtime()).screen([]);
    should(screen).match(ONBOARDING);
    should(screen).not.match(PROMPT);
  });

  it('shows the trust prompt when only onboarding is recorded (the control)', async () => {
    const screen = await (await runtime({ onboarded: true })).screen([]);
    should(screen).match(TRUST);
    should(screen).not.match(PROMPT);
  });

  it('reaches the prompt with hasCompletedOnboarding and projects[cwd].hasTrustDialogAccepted written', async () => {
    const screen = await (await runtime({ onboarded: true, trusted: true })).screen([]);
    should(screen).match(PROMPT);
    should(screen).not.match(TRUST);
    should(screen).not.match(ONBOARDING);
  });

  it('accepts --permission-mode auto', async () => {
    const screen = await (await runtime({ onboarded: true, trusted: true })).screen(['--permission-mode', 'auto']);
    should(screen).match(AUTO_ON);
  });

  it('rejects an unknown permission mode, and lists auto and bypassPermissions among the accepted ones', async () => {
    const r = await runtime({ onboarded: true, trusted: true });
    const ran = await run([claude().bin, '--permission-mode', 'fy-not-a-mode', '-p', 'unused'], {
      env: r.env,
      cwd: r.cwd,
    });
    const said = `${ran.stdout}${ran.stderr}`;
    const choices = /Allowed choices are ([^\n.]+)/.exec(said)?.[1] ?? '';
    should(choices.length).be.above(0, `claude stopped naming its permission modes: ${said.slice(0, 300)}`);
    should(choices.split(/,\s*/)).containEql('auto').and.containEql('bypassPermissions');
  });

  it('warns before bypassPermissions without the fixed settings (the control)', async () => {
    const screen = await (
      await runtime({ onboarded: true, trusted: true })
    ).screen(['--permission-mode', 'bypassPermissions']);
    should(screen).match(BYPASS_WARNING);
  });

  it('accepts bypassPermissions with no warning when a --settings overlay carries skipDangerousModePermissionPrompt', async () => {
    const r = await runtime({ onboarded: true, trusted: true });
    const fixed = await r.overlay({ skipDangerousModePermissionPrompt: true });
    const screen = await r.screen(['--permission-mode', 'bypassPermissions', '--settings', fixed]);
    should(screen).match(BYPASS_ON);
    should(screen).not.match(BYPASS_WARNING);
  });

  it("merges the --settings overlay with the config dir's own settings.json rather than replacing it", async () => {
    // The mode comes ONLY from the file and the warning's suppression ONLY from the overlay; seeing
    // bypass on with no warning needs both.
    const r = await runtime({
      onboarded: true,
      trusted: true,
      settings: { permissions: { defaultMode: 'bypassPermissions' } },
    });
    const fixed = await r.overlay({ skipDangerousModePermissionPrompt: true });
    const screen = await r.screen(['--settings', fixed]);
    should(screen).match(BYPASS_ON);
    should(screen).not.match(BYPASS_WARNING);
  });

  /**
   * The auto-mode nudge: shown once to a config dir whose USER settings.json names a non-auto mode,
   * when no other settings source names one. A fixed-layer agent runtime is exactly that dir, so it
   * parked on the dialog and every message to it failed. Either half of the fix suppresses it alone.
   */
  const nudgeRuntime = (state: Record<string, unknown> = {}) =>
    runtime({
      onboarded: true,
      trusted: true,
      settings: { permissions: { defaultMode: 'bypassPermissions' } },
      state: { ...NUDGE_FLAG, ...state },
      env: NUDGE_ENV,
    });
  const NUDGE_WAIT_MS = 15_000;

  it('parks a bypass runtime on the auto-mode nudge when nothing suppresses it (the control)', async () => {
    const r = await nudgeRuntime();
    const fixed = await r.overlay({ skipDangerousModePermissionPrompt: true });
    const screen = await r.screen(
      ['--permission-mode', 'bypassPermissions', '--settings', fixed],
      [AUTO_NUDGE],
      NUDGE_WAIT_MS,
    );
    should(screen).match(AUTO_NUDGE);
  });

  it('never shows the auto-mode nudge once .claude.json records hasSeenAutoDefaultNudge', async () => {
    const r = await nudgeRuntime({ hasSeenAutoDefaultNudge: true });
    const fixed = await r.overlay({ skipDangerousModePermissionPrompt: true });
    const screen = await r.screen(
      ['--permission-mode', 'bypassPermissions', '--settings', fixed],
      [AUTO_NUDGE],
      NUDGE_WAIT_MS,
    );
    should(screen).match(BYPASS_ON);
    should(screen).not.match(AUTO_NUDGE);
  });

  it('never shows the auto-mode nudge when the --settings overlay names the permission mode itself', async () => {
    const r = await nudgeRuntime();
    const fixed = await r.overlay({
      permissions: { defaultMode: 'bypassPermissions' },
      skipDangerousModePermissionPrompt: true,
    });
    const screen = await r.screen(
      ['--permission-mode', 'bypassPermissions', '--settings', fixed],
      [AUTO_NUDGE],
      NUDGE_WAIT_MS,
    );
    should(screen).match(BYPASS_ON);
    should(screen).not.match(AUTO_NUDGE);
  });

  describe('Remote Control at startup', () => {
    const ON = { remoteControlAtStartup: true };

    it(
      'attempts the Remote Control bridge when the user settings turn it on (the control)',
      async () => {
        const r = await runtime({ onboarded: true, trusted: true, settings: ON });
        should((await r.bridgeLog([])).length).be.above(0);
      },
      BRIDGE_TEST_MS,
    );

    it(
      'never attempts the bridge when a --settings overlay turns it off over the user settings',
      async () => {
        const r = await runtime({ onboarded: true, trusted: true, settings: ON });
        const fixed = await r.overlay({ remoteControlAtStartup: false });
        should(await r.bridgeLog(['--settings', fixed])).eql([]);
      },
      BRIDGE_TEST_MS,
    );
  });
});
