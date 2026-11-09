/**
 * The try-it preview's plan: which parts of a v4 home a preview may copy, which it may never copy, which conversion
 * steps run on that copy, and the fixed facts of the preview (port, home, wrapper). Pure: no file is opened here.
 *
 * The rule is an ALLOWLIST. A path nobody named is not copied, so a credential nobody thought of stays behind. Over
 * the allowlist sits a DENY list that wins: a name that looks like a secret is refused even where its folder is
 * allowed. Both are decided from the path alone, before any copy, and never from a file's content.
 */
import { STEPS, type Step } from '../src/steps/index.ts';

export const PREVIEW = {
  /** v4 owns 7457; the preview owns the next number. */
  port: 7458,
  /** The preview home, relative to the user's home directory. */
  homeFolder: '.ferretry-v5',
  /** The wrapper's name inside `<home>/bin`. */
  wrapper: 'fy5',
  /** The app the preview's daemon links to; the daemon is compiled with this origin. */
  appOrigin: 'https://ferretry-v5.pages.dev',
  /** The daemon's terminal socket in 5.0 is `<home>/state/terminals/tmux.sock`: a separate home is a separate socket. */
  tmuxSocket: 'state/terminals/tmux.sock',
  /** The private folder the daemon's XDG_RUNTIME_DIR names, so no user systemd manager is reachable (relative to the home). */
  xdgRunFolder: 'xdg-run',
} as const;

// ─── what may be copied ─────────────────────────────────────────────────────────────────────────────────────────

/** One thing a preview copies: a name or a folder of the v4 home, and why the conversion needs it. */
export interface Allowed {
  readonly path: string;
  readonly kind: 'file' | 'folder';
  readonly why: string;
}

const file = (path: string, why: string): Allowed => ({ path, kind: 'file', why });
const folder = (path: string, why: string): Allowed => ({ path, kind: 'folder', why });

export const ALLOWED: readonly Allowed[] = [
  file('layout-version', 'the converter refuses a folder without the v4 layout marker'),
  file('fleet/ids.json', 'ferret and runtime ids (ferrets, settings, packs, lessons read it)'),
  folder('fleet/assets', 'instruction documents and skill folders the settings and skill-folders steps carry'),
  file('config/machine.yaml', 'settings'),
  file('config/warden.yaml', 'settings'),
  file('config/limits.yaml', 'settings'),
  file('config/account-defaults.yaml', 'settings'),
  file('config/voice.yaml', 'settings'),
  file('config/learning.yaml', 'lessons'),
  file('config/pack.yaml', 'packs'),
  file('config/models-guide.yaml', 'packs'),
  file('config/routing.json', 'packs'),
  folder('config/runtimes', 'settings'),
  folder('config/profiles', 'settings'),
  folder('config/presets', 'settings'),
  folder('config/models', 'settings'),
  folder('config/components', 'settings'),
  file('state/config-accepted.json', 'accepted-config'),
  file('state/projects.json', 'projects'),
  file('state/agent-pins.json', 'ferrets'),
  file('state/callsigns.json', 'ferrets'),
  file('state/archived-sessions.json', 'ferrets'),
  file('state/worktrees.json', 'ferrets'),
  folder('state/forks', 'ferrets'),
  folder('state/board', 'board'),
  folder('board', 'board lanes and switch, at the home root'),
  folder('state/learning', 'lessons'),
  folder('state/warden', 'warden history'),
  folder('state/pack-guide', 'packs'),
  file('state/pack-guide-replaced.json', 'packs'),
  file('state/budget-holds.json', 'usage'),
  file('state/budget-told.json', 'usage'),
  folder('state/machine-agenda', 'asks'),
  file('state/notifications.jsonl', 'asks'),
  folder('state/shared-drafts', 'conversation'),
  folder('state/sessions', 'ferrets, conversation, asks: only the per-ferret files named in SESSION_FILES'),
];

/**
 * The files and folders of ONE ferret's folder (`state/sessions/<sid>/`) a preview copies. Everything else in it is
 * left behind: `environment.json` is a plaintext credential, `terminal-pane.json` is the handle of a live terminal
 * the preview must never adopt, `last-snapshot.txt` is a terminal's last screen and may hold anything typed there.
 */
export const SESSION_FILES: readonly string[] = [
  'config.json',
  'state.json',
  'pins.json',
  'events.jsonl',
  'question-asked.json',
  'agenda.json',
  'agenda-replies.json',
  'agenda-seen.json',
  'agenda-history.jsonl',
  'attention.json',
  'attention-replies.json',
  'agenda-versions',
  'channel',
  'turns',
];

// ─── what may never be copied ───────────────────────────────────────────────────────────────────────────────────

/** A name that is refused wherever it appears, even inside an allowed folder. The first match explains the refusal. */
export const DENIED: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /(^|\/)environment\.json$/u, why: 'a ferret environment file: a plaintext credential' },
  { pattern: /(^|\/)terminal-pane\.json$/u, why: 'a live terminal handle: the preview must never adopt v4 terminals' },
  { pattern: /(^|\/)last-snapshot\.txt$/u, why: 'a terminal screen: it may hold anything a person typed' },
  { pattern: /\.key$/u, why: 'a key file' },
  { pattern: /(^|\/)(credentials|homes)(\/|$)/u, why: 'harness sign-ins and harness homes' },
  { pattern: /(^|\/)api-(warden-)?token$/u, why: 'an admin or warden token' },
  {
    pattern: /secret|passkey|unlock|oauth|vault|identity|devices|push|link-keys/iu,
    why: 'a credential or pairing record',
  },
  { pattern: /(^|\/)daemon\.json/u, why: 'the daemon document: v4 port, relay and grants must not reach the preview' },
  { pattern: /(^|\/)security\.json$/u, why: 'v4 security settings' },
  { pattern: /(^|\/)config\/logins(\/|$)/u, why: 'logins are left out entirely' },
  // Inside the arbitrary folders that ARE copied (catalog installs, MCP bodies) anything may sit: refuse the names a
  // credential usually has.
  { pattern: /(^|\/)\.env(\.[^/]*)?$/u, why: 'an environment file' },
  { pattern: /\.(pem|p12|pfx|jks|keystore|crt)$/iu, why: 'a certificate or private key file' },
  { pattern: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)[^/]*$/u, why: 'an ssh key' },
  {
    pattern: /(^|\/)(auth\.json|\.credentials\.json|\.netrc|\.npmrc|\.pypirc|\.git-credentials)$/u,
    why: 'a sign-in file',
  },
  { pattern: /(^|\/)[^/]*token[^/]*$/iu, why: 'a token file' },
];

/** Why each top-level name of a v4 home is NOT copied, for the report. Names only; nothing here is opened. */
export const LEFT_BEHIND: readonly { readonly path: string; readonly why: string }[] = [
  {
    path: 'config/logins',
    why: "logins are left out entirely: a host login is the owner's real sign-in; add them fresh",
  },
  { path: 'api-token', why: 'admin token' },
  { path: 'api-warden-token', why: 'warden token' },
  { path: 'fleet/credentials', why: 'harness sign-ins (login tokens)' },
  { path: 'fleet/homes', why: 'harness homes hold the .claude and .codex sign-ins; never opened, never listed' },
  { path: 'fleet/shared', why: 'conversation transcript pool: private, large, and tied to the harness homes' },
  { path: 'fleet/manifest.json', why: 'fleet manifest: only the skipped harness-homes step reads it' },
  { path: 'fleet/setup', why: 'export keys and import files for fleet sharing' },
  { path: 'fleet/bin', why: 'v4 program files' },
  {
    path: 'state/secrets.json, state/secrets.key',
    why: 'the vault and its key: the preview starts with an empty vault',
  },
  { path: 'state/daemon-identity.json', why: 'the daemon identity: the preview makes its own' },
  {
    path: 'state/devices.json, passkeys.json, unlocks.json, push*.json',
    why: 'paired devices, passkeys, push: the owner pairs fresh',
  },
  { path: 'state/login-entries*.json, login-secrets.json', why: 'website accounts and their sealed values' },
  { path: 'state/mcp-oauth.json, mcp-oauth-secrets.json', why: 'MCP sign-ins' },
  { path: 'state/session-message-token.key', why: 'message signing key' },
  { path: 'state/catalogs, catalog-install*.json', why: 'shares: link keys and member passkeys live there' },
  {
    path: 'state/security.json, grant-audit.jsonl, security-audit.jsonl, audit*.jsonl',
    why: 'v4 security settings and audit logs',
  },
  { path: 'config/daemon.json*', why: 'v4 port 7457, relay registration and grants' },
  { path: 'tmux.sock, daemon.lock, tunnel.json', why: 'v4 live sockets and runtime files' },
  { path: 'state/index, state/tmp, state/update, *.log, logs', why: 'caches and logs: 5.0 rebuilds them' },
  {
    path: 'state/sessions/<sid>/{environment,terminal-pane,last-snapshot}',
    why: 'credential, live terminal handle, terminal screen',
  },
  {
    path: 'state/sessions/<sid>/{media,effects,checks,summary.md,done.marker,...}',
    why: 'not read by any step that runs',
  },
];

// ─── the decision ───────────────────────────────────────────────────────────────────────────────────────────────

export type Decision =
  | { readonly verdict: 'copy'; readonly why: string }
  /** A folder to look inside: it is allowed, but only some of what it holds is. */
  | { readonly verdict: 'descend'; readonly why: string }
  | { readonly verdict: 'leave'; readonly why: string };

const SLASH = /\/+/u;
const isSession = (parts: readonly string[]) => parts[0] === 'state' && parts[1] === 'sessions';

/**
 * Whether a path (relative to the v4 home, `/`-separated) is copied. `isFolder` is what the caller already knows from
 * its directory listing. The denylist is asked first and always wins.
 */
export function decide(relative: string, isFolder: boolean): Decision {
  const rel = relative.split(SLASH).filter(Boolean).join('/');
  if (rel === '') return { verdict: 'descend', why: 'the home itself' };
  for (const deny of DENIED) if (deny.pattern.test(rel)) return { verdict: 'leave', why: deny.why };
  const parts = rel.split('/');

  if (isSession(parts)) {
    if (parts.length === 2) return { verdict: 'descend', why: 'the ferrets' };
    if (parts.length === 3)
      return isFolder
        ? { verdict: 'descend', why: 'one ferret' }
        : { verdict: 'leave', why: 'a stray file among the ferrets' };
    const inside = parts[3] as string;
    if (!SESSION_FILES.includes(inside)) return { verdict: 'leave', why: 'not read by any step that runs' };
    return isFolder
      ? { verdict: 'descend', why: 'a ferret folder a step reads' }
      : { verdict: 'copy', why: 'a ferret file a step reads' };
  }

  const attachment = /^state\/attachments(\/|$)/u.test(rel);
  if (attachment) {
    if (isFolder) return { verdict: 'descend', why: 'attachment records' };
    return parts[parts.length - 1] === 'manifest.json'
      ? { verdict: 'copy', why: 'an attachment record (the original is never copied)' }
      : { verdict: 'leave', why: 'an attachment original' };
  }

  for (const allowed of ALLOWED) {
    if (rel === allowed.path) return { verdict: isFolder ? 'descend' : 'copy', why: allowed.why };
    if (isFolder && allowed.path.startsWith(`${rel}/`)) return { verdict: 'descend', why: `holds ${allowed.path}` };
    if (rel.startsWith(`${allowed.path}/`) && allowed.kind === 'folder')
      return { verdict: isFolder ? 'descend' : 'copy', why: allowed.why };
  }
  return { verdict: 'leave', why: 'not on the preview allowlist' };
}

// ─── the conversion steps ───────────────────────────────────────────────────────────────────────────────────────

/** The steps that never run on a preview, and why. Every one is named by its id in `STEPS`. */
export const SKIPPED_STEPS: readonly { readonly id: string; readonly why: string }[] = [
  { id: 'terminals', why: 'it would adopt v4 live ferrets by pane handle' },
  {
    id: 'harness-homes',
    why: 'harness homes hold the .claude and .codex sign-ins (the owner asked for them left out)',
  },
  { id: 'logins', why: 'harness sign-ins: the owner signs in fresh' },
  { id: 'vault', why: 'the vault and its key: the preview starts with an empty vault' },
  { id: 'mcp', why: 'MCP sign-ins and their sealed refresh tokens' },
  { id: 'identity', why: 'the daemon identity: the 5.0 daemon makes its own at first start' },
  { id: 'accounts', why: 'website accounts and their sealed values' },
  { id: 'access', why: 'paired devices, passkeys and push: the owner pairs fresh' },
  { id: 'gate', why: 'admin and warden tokens and the v4 audit log' },
  {
    id: 'daemon-settings',
    why: 'it carries v4 port 7457, relay and grants; the preview binds 7458 and discovers its own relay',
  },
  { id: 'catalogs', why: 'shares: link keys and member passkeys' },
  { id: 'archive-setting', why: 'it reads the host service files of the machine, which belong to v4' },
];

export interface StepPlan {
  readonly run: readonly Step[];
  readonly skipped: readonly { readonly id: string; readonly title: string; readonly why: string }[];
  /** Skipped ids that name no step: a renamed step must not silently start running. */
  readonly unknown: readonly string[];
}

export function stepPlan(steps: readonly Step[] = STEPS): StepPlan {
  const skip = new Map(SKIPPED_STEPS.map(entry => [entry.id, entry.why]));
  const known = new Set(steps.map(step => step.id));
  return {
    run: steps.filter(step => !skip.has(step.id)),
    skipped: steps
      .filter(step => skip.has(step.id))
      .map(step => ({ id: step.id, title: step.title, why: skip.get(step.id) as string })),
    unknown: SKIPPED_STEPS.filter(entry => !known.has(entry.id)).map(entry => entry.id),
  };
}

// ─── the known gaps ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the preview does NOT protect, in plain words. The dry run prints this list, and the owner reads it before
 * `prepare`. A gap is a thing the owner must know, not a promise that it is handled.
 */
export const GAPS: readonly string[] = [
  "The preview's ferrets run as you and can read and change ~/.ferretry; nothing fences them (the fence unit has not landed). This includes the preview's own private files.",
  'Onboarding\'s "import from this machine", and adding a login with `store: host`, would use YOUR real sign-in (the one under your home folder). Do neither in the preview; add logins fresh.',
  "limits.yaml is not read for launches: Ferrets offers no effectiveLimits, so Terminals launches with the defaults whatever limits.yaml says (v4 honoured it). What keeps the preview off v4's systemd slices is NOT that file: the preview daemon starts with no reachable user systemd manager (XDG_RUNTIME_DIR is a private folder in the preview home, DBUS_SESSION_BUS_ADDRESS is dropped), so every launch runs directly, with no slice, scope or `systemctl set-property`. `preview.sh start` refuses to start if it can still reach your manager. Do not start the preview daemon any other way, and do not turn limits on in the preview: a daemon that reached your systemd would reset v4's `ferretry_fleet.slice` and per-ferret slices to the 5.0 defaults.",
  "Ferrets whose folder was inside v4's home or v4's worktree folder, inside a worktree v4's ledger lists, or under any `.worktrees` folder lost their folder: they point at an empty `workspace` folder in the preview home, so a resumed one never runs in a live v4 checkout. A preview ferret in a primary checkout shares that checkout with v4's agents: it keeps its folder and CAN change real files there when you resume it.",
  'Every ferret is stopped and nothing resumes by itself. Starting one in the preview starts a new agent; it does not continue the v4 conversation.',
  "An agent with your GitHub credential can still push a `v*` tag. What stops a tag from publishing is cd.yaml's main-only job (the tagged commit must be on main), and it cannot publish from a 5.0 commit made after this guard lands. Any commit made before it (all current 5.0 history) can still publish if tagged. The tag ruleset refuses Write-role collaborators only; every agent here pushes as you (Admin), so it does not stop an agent's tag.",
  'The preview signing key is only as safe as push access to rebuild/5.0: whoever can push that branch can change what the v5 app signs.',
  "`fy5` pins the preview address, so the preview CLI never talks to v4. A tool started OUTSIDE `fy5` (a bare `fy` from your normal shell) is v4's, and is not stopped by anything here.",
  "A login shell finds v4's `fy` first on this box (/etc/profile.d/nix.sh puts the nix profile ahead of the preview's `bin`). Preview Claude ferrets get the guard `__ETC_PROFILE_NIX_SOURCED=1` plus FY_HOME, FY_PORT and FY_URL through a harness settings item (`config/claude-code/settings/fy-preview.yaml`), and `preview.sh start` refuses to start unless `bash -lc` and `zsh -lic` with that environment find the preview's `fy`. Codex ferrets and the web and agent terminals cannot carry it (5.0's Codex settings items are not applied, and its terminals config has no environment): in a preview terminal you open yourself, `fy` may be v4's: type `~/.ferretry-v5/bin/fy` or use `fy5`.",
  'Harness updates started from the preview (Claude Code or Codex "update") run npm or the native updater on YOUR installed tools. They only run when you ask for them.',
  'The preview daemon asks the user systemd manager one read-only question when it starts (`systemctl --user show-environment`) and runs an `ionice` probe. In the preview the question is answered "no manager" by design (see the limits line). It changes nothing of v4\'s.',
  "tmux: the preview uses its own socket under its home (<home>/state/terminals/tmux.sock), so it is a different tmux server from v4's.",
  "The lifecycle claim files beside v4's service unit are only written by a lifecycle verb (stop, restart, install, uninstall, reset, update). `fy5` refuses those; `preview.sh proof` checks that none appeared, and compares a content hash of each claim file that existed (they are locks, not credentials).",
  'Names the preview shares with v4 but only reads: /etc/ferretry/loopback-firewall.conf, /run/ferretry/loopback-firewall.json, and the `ferretry_voice.slice` read.',
  "5.0 does not read `browserPorts`, so the preview's browser ports are random. That is harmless; it is only noted so nobody chases it.",
];
