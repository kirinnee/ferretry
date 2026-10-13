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
/** The input footer: "? for shortcuts" until 2.1.2xx, the permission-mode line once auto became the default. */
const PROMPT = /\? for shortcuts|shift\+tab to cycle/;
const BYPASS_WARNING = /Bypass Permissions mode/;
const BYPASS_ON = /bypass permissions on/;
const AUTO_ON = /auto mode on/;
const SETTLED = [ONBOARDING, TRUST, PROMPT, BYPASS_WARNING];

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
    options: { onboarded?: boolean; trusted?: boolean; settings?: Record<string, unknown> } = {},
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
    if (Object.keys(state).length > 0) await writeFile(path.join(config, '.claude.json'), JSON.stringify(state));
    if (options.settings !== undefined)
      await writeFile(path.join(config, 'settings.json'), JSON.stringify(options.settings));
    const env = harnessEnv(home, proxy.port, { CLAUDE_CONFIG_DIR: config, CLAUDE_SECURESTORAGE_CONFIG_DIR: store });
    const overlay = async (document: Record<string, unknown>) => {
      const file = path.join(root, 'fixed.json');
      await writeFile(file, JSON.stringify(document));
      return file;
    };
    const screen = (args: string[]) => screenOf([claude().bin, ...args], { env, cwd, settled: SETTLED });
    return { screen, overlay, env, cwd };
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
});
