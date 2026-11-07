import type { VerbInvocation } from '@ferretry/kernel/manifest';
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { requireMayApply } from './authority.ts';
import { type ChangeFlags, parseReason, parseUntil, runChange } from './change.ts';
import { type LoginsCommandDeps, LoginsCommandError } from './ports.ts';
import {
  renderLoginList,
  renderLoginRow,
  renderModelCatalogs,
  renderModelRefresh,
  renderPresetList,
} from './render.ts';
import { runSignIn } from './sign-in.ts';

/** One verb: it prints through `deps.out`, sets the exit code there and refuses by throwing a `LoginsCommandError`. */
export type VerbBody = (deps: LoginsCommandDeps, invocation: VerbInvocation) => Promise<void>;

/** A switch that is on: `--name`, `--name=true`. */
const flagOn = (invocation: VerbInvocation, ...names: readonly string[]): boolean =>
  names.some(name => invocation.options[name] === true || invocation.options[name] === 'true');

/** A required positional, or a refusal naming what is missing. */
function loginArg(invocation: VerbInvocation): string {
  const value = invocation.args[0];
  if (value === undefined || value === '') throw new LoginsCommandError('Say which login.');
  return value;
}

/** `login ls`: the Sign-ins tab in a terminal. */
export const loginLs: VerbBody = async (deps, invocation) => {
  const list = await deps.gateway.logins();
  deps.out.report(flagOn(invocation, 'json') ? JSON.stringify(list, null, 2) : renderLoginList(list, deps.binaryName));
};

/** `login check <id>`: check now whether a login still works (a refresh for Codex). */
export const loginCheck: VerbBody = async (deps, invocation) => {
  const id = loginArg(invocation);
  await requireMayApply(deps);
  const view = await deps.gateway.check(id);
  deps.out.report(
    flagOn(invocation, 'json') ? JSON.stringify(view, null, 2) : renderLoginRow(view, deps.binaryName).join('\n'),
  );
  if (view.status.word === 'needs_sign_in') {
    if (!flagOn(invocation, 'json')) deps.out.error(`${id} needs sign-in: ${deps.binaryName} login signin ${id}`);
    deps.out.setExitCode(1);
  }
};

/** `login test <id> [--allow-inference]`: one call, the cheapest its provider allows. */
export const loginTest: VerbBody = async (deps, invocation) => {
  const id = loginArg(invocation);
  await requireMayApply(deps);
  const result = await deps.gateway.test(id, flagOn(invocation, 'allow-inference'));
  const json = flagOn(invocation, 'json');
  deps.out.report(json ? JSON.stringify(result, null, 2) : `${id}: ${result.message}`);
  if (result.code === 'consent_required' && !json) {
    deps.out.error(`To send it: ${deps.binaryName} login test ${id} --allow-inference`);
  }
  if (!result.ok) deps.out.setExitCode(1);
};

/** `login presets`: the provider presets an environment login can be made from. */
export const loginPresets: VerbBody = async (deps, invocation) => {
  const catalog = await deps.gateway.presets();
  deps.out.report(
    flagOn(invocation, 'json') ? JSON.stringify(catalog, null, 2) : renderPresetList(catalog, deps.binaryName),
  );
};

/** `login signin <id> [--force]`: the harness's own sign-in, this terminal as the screen. */
export const loginSignin: VerbBody = async (deps, invocation) => {
  await runSignIn(deps, loginArg(invocation), { force: flagOn(invocation, 'force') });
};

/** `login models list`: every model catalog in effect, where it came from, and its models by tier. */
export const loginModelsList: VerbBody = async (deps, invocation) => {
  const view = await deps.gateway.models();
  deps.out.report(flagOn(invocation, 'json') ? JSON.stringify(view, null, 2) : renderModelCatalogs(view));
};

/** `login models refresh`: check now for a newer published model catalog. */
export const loginModelsRefresh: VerbBody = async (deps, invocation) => {
  const result = await deps.gateway.refreshModels();
  deps.out.report(flagOn(invocation, 'json') ? JSON.stringify(result, null, 2) : renderModelRefresh(result));
};

// ── The verbs that CHANGE a login ──────────────────────────────────────────────────────────────────────────────────
//
// Each stages one intent at Logins' own change route, shows what applying it would do, and applies exactly that.
// A caller who may not change the machine is refused in words before anything starts.

/** A text option (`--label x`), or `undefined`. */
function textOption(invocation: VerbInvocation, name: string): string | undefined {
  const value = invocation.options[name];
  return typeof value === 'string' ? value : undefined;
}

/** The flags every change carries. */
const changeFlags = (invocation: VerbInvocation): ChangeFlags => ({
  dryRun: flagOn(invocation, 'dry-run'),
  yes: flagOn(invocation, 'yes', 'y'),
  json: flagOn(invocation, 'json'),
});

const LOGIN_ID_LIMIT = 64;

/** A login id from a label: lowercase letters, digits and dashes. */
const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

/** The id a new login gets when nobody names one: `<harness>-<label>`, or `<harness>-login`, then `-2`, `-3`… until free. */
export function suggestLoginId(harness: HarnessKey, label: string | undefined, taken: ReadonlySet<string>): string {
  const base = `${harness === 'claude-code' ? 'claude' : 'codex'}-${slug(label ?? '') || 'login'}`.slice(
    0,
    LOGIN_ID_LIMIT - 3,
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A tool as a person typed it. */
function toolOf(word: string): HarnessKey | undefined {
  const tool = word.trim().toLowerCase();
  if (tool === 'claude' || tool === 'claude-code') return 'claude-code';
  return tool === 'codex' ? 'codex' : undefined;
}

/** Every `--env NAME=VALUE`, repeated or not. */
function envOptions(invocation: VerbInvocation): Record<string, string> {
  const raw = invocation.options.env;
  const pairs = raw === undefined || typeof raw === 'boolean' ? [] : typeof raw === 'string' ? [raw] : raw;
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    if (separator <= 0) throw new LoginsCommandError(`Write --env as NAME=VALUE, not ${pair}`);
    env[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return env;
}

/**
 * The environment half of `login add` (docs/provider-presets.md): nothing when none of its options is given, else an
 * environment login — from a preset's variables when one is named, each overridden by an `--env`, a secret as
 * `${secret:NAME}` and never a value.
 */
async function environmentLogin(
  deps: LoginsCommandDeps,
  harness: HarnessKey,
  invocation: VerbInvocation,
  presetId: string | undefined,
): Promise<{ store?: 'environment'; preset?: string; env?: Record<string, string>; cloudCredential?: string }> {
  const given = envOptions(invocation);
  const cloudOption = textOption(invocation, 'cloud-credential');
  if (presetId === undefined && Object.keys(given).length === 0 && cloudOption === undefined) return {};
  const preset =
    presetId === undefined ? undefined : (await deps.gateway.presets()).presets.find(entry => entry.id === presetId);
  if (presetId !== undefined && preset === undefined) {
    throw new LoginsCommandError(`There is no preset ${presetId}: see \`${deps.binaryName} login presets\``);
  }
  if (preset?.offered.available === false) throw new LoginsCommandError(preset.offered.reason);
  if (preset !== undefined && !preset.halves.some(half => half.harness === harness && half.offered.available)) {
    throw new LoginsCommandError(`${preset.label} does not drive ${HARNESS_WORDS[harness]}`);
  }
  const defaults = Object.fromEntries(
    (preset?.variables ?? []).map(variable => [
      variable.name,
      variable.kind === 'secret' ? `\${secret:${variable.secret ?? variable.name}}` : (variable.value ?? ''),
    ]),
  );
  const cloudCredential = cloudOption ?? preset?.cloudCredential?.suggested;
  return {
    store: 'environment',
    ...(preset === undefined ? {} : { preset: preset.id }),
    env: { ...defaults, ...given },
    ...(cloudCredential === undefined ? {} : { cloudCredential }),
  };
}

const HARNESS_WORDS: Readonly<Record<HarnessKey, string>> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/**
 * `login add claude|codex [--label X] [--id X] [--no-sign-in] [--preset X] [--env NAME=VALUE] [--cloud-credential X]`,
 * or `login add <provider>` for a provider on `login presets`: a sign-in, or an environment login from a preset.
 *
 * GAP(vault): a provider's secrets are not prompted for here (the Vault's routes are another plugin's); store each
 * with `fy secret set NAME` and name it as `--env NAME='${secret:NAME}'`.
 */
export const loginAdd: VerbBody = async (deps, invocation) => {
  await requireMayApply(deps);
  const word = invocation.args[0]?.trim();
  if (word === undefined || word === '') {
    throw new LoginsCommandError(`Name a tool or provider: ${deps.binaryName} login add claude|codex|<provider>`);
  }
  const tool = toolOf(word);
  const presetId = textOption(invocation, 'preset') ?? (tool === undefined ? word : undefined);
  const provider =
    tool === undefined ? (await deps.gateway.presets()).presets.find(entry => entry.id === presetId) : undefined;
  if (tool === undefined && provider === undefined) {
    throw new LoginsCommandError(`There is no provider "${word}": see \`${deps.binaryName} login presets\``);
  }
  const harness = (tool ?? provider?.harness) as HarnessKey;
  const label = textOption(invocation, 'label');
  const taken = new Set((await deps.gateway.logins()).logins.map(entry => entry.id));
  const id = textOption(invocation, 'id') ?? suggestLoginId(harness, label ?? presetId, taken);
  const flags = changeFlags(invocation);
  const environment = await environmentLogin(deps, harness, invocation, presetId);
  const outcome = await runChange(deps, {
    change: { kind: 'login.add', id, harness, ...(label === undefined ? {} : { label }), ...environment },
    destructive: false,
    flags,
  });
  if (outcome === undefined || flags.json) return;
  if (environment.store === 'environment') {
    deps.out.report(
      `Store each secret it names with \`${deps.binaryName} secret set NAME\`, then: ${deps.binaryName} login test ${id}`,
    );
    return;
  }
  if (flagOn(invocation, 'no-sign-in') || invocation.options['sign-in'] === false) {
    deps.out.report(`Sign it in when you are ready: ${deps.binaryName} login signin ${id}`);
    return;
  }
  await runSignIn(deps, id);
};

/** `login signout <id>`: the harness's own logout; every runtime on it then needs sign-in. */
export const loginSignout: VerbBody = async (deps, invocation) => {
  await runChange(deps, {
    change: { kind: 'login.signout', id: loginArg(invocation) },
    destructive: true,
    flags: changeFlags(invocation),
  });
};

/** `login disable <id> [--until WHEN] [--reason TEXT]`: nothing new starts on it; running ferrets keep going. */
export const loginDisable: VerbBody = async (deps, invocation) => {
  const reason = parseReason(textOption(invocation, 'reason'));
  const until = textOption(invocation, 'until');
  await runChange(deps, {
    change: {
      kind: 'login.disable',
      id: loginArg(invocation),
      ...(reason === undefined ? {} : { reason }),
      ...(until === undefined ? {} : { until: parseUntil(until, deps.now()) as never }),
    },
    destructive: false,
    flags: changeFlags(invocation),
  });
};

/** `login enable <id>`: switch a disabled login back on. */
export const loginEnable: VerbBody = async (deps, invocation) => {
  await runChange(deps, {
    change: { kind: 'login.enable', id: loginArg(invocation) },
    destructive: false,
    flags: changeFlags(invocation),
  });
};

/** `login label <id> <label>` or `login label <id> --clear`. */
export const loginLabel: VerbBody = async (deps, invocation) => {
  const id = loginArg(invocation);
  const label = invocation.args[1]?.trim();
  const clear = flagOn(invocation, 'clear');
  if (!clear && (label === undefined || label === '')) {
    throw new LoginsCommandError(`Name the label, or pass --clear: ${deps.binaryName} login label ${id} work`);
  }
  await runChange(deps, {
    change: { kind: 'login.label', id, label: clear ? null : (label as string) },
    destructive: false,
    flags: changeFlags(invocation),
  });
};

/** `login rm <id>`: remove a login (refused while a runtime uses it). */
export const loginRm: VerbBody = async (deps, invocation) => {
  await runChange(deps, {
    change: { kind: 'login.remove', id: loginArg(invocation) },
    destructive: true,
    flags: changeFlags(invocation),
  });
};
