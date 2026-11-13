/**
 * The try-it preview's plan: which parts of a v4 home a preview may copy, which it may never copy, which conversion
 * steps run on that copy, and the fixed facts of the preview (port, home, wrapper). Pure: no file is opened here.
 *
 * The rule is an ALLOWLIST. A path nobody named is not copied, so a credential nobody thought of stays behind. Over
 * the allowlist sits a DENY list that wins: a name that looks like a secret is refused even where its folder is
 * allowed. Both are decided from the path alone, before any copy, and never from a file's content.
 */
import { STEPS, type Step } from '../src/steps/index.ts';
import { CODEX_HELD_SENTENCE, NO_HOST_CREDS_FOLDER } from '../src/v5/preview-env.ts';

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
  /**
   * The folder (relative to the home) that holds what stands where the owner's host credentials would be: `gh/` (the
   * daemon's GH_CONFIG_DIR, empty, 0700), `home/` (its HOME, 0700, EMPTY), `zdot/` (the terminals' ZDOTDIR, 0700, one empty 0600 `.zshrc`) and `gitconfig` (its GIT_CONFIG_GLOBAL, empty,
   * 0600). `fy5 daemon start` makes it fresh, `preview.sh stop` removes it.
   */
  noCredsFolder: NO_HOST_CREDS_FOLDER,
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
  folder(
    'fleet/assets',
    'instruction documents, files a carried hook or setting names, and skill folders the settings and skill-folders steps carry',
  ),
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
  {
    pattern: /(^|\/)config\/logins(\/|$)/u,
    why: "login files are never staged: the Settings step builds each login's signed-out shell from the v4 source straight into the preview home",
  },
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
    why: 'no login file is staged (a failed prepare leaves none): the Settings step BUILDS each login a signed-out shell (harness, store, label, preset, env references) from the v4 source and moves its budget, rebuilt from its numbers, into config/usage.yaml (the only place 5.0 enforces a cap); a literal env value is never carried (it becomes a ${secret:NAME} reference), disabled, clonedFrom*, cloudCredential and codexProvider are left behind, store: host becomes store: ferretry, a Codex login, a login with no way to sign in and a login whose budget does not parse are held',
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
  {
    id: 'logins',
    why: 'harness sign-ins (fleet/credentials): never carried; the login FILES are carried signed out by the Settings step, and the owner signs in fresh',
  },
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
  'Your v4 logins are carried SIGNED OUT, as empty shells (harness, store, label, preset and env references only; the spend cap v4 enforced is moved to usage.yaml, rebuilt from its numbers; a plain key is never carried, the preview vault is empty, and `store: host` is written as `store: ferretry`), so every Claude Code runtime loads and shows "Needs sign-in". You sign in fresh: `fy5 login signin <id>` for a Claude login, or `fy5 secret set <NAME>` then `fy5 login test <id>` for an environment login. Codex logins are held with the Codex runtimes. Onboarding\'s "import from this machine", and adding a login with `store: host`, look under the daemon\'s HOME, which is the empty preview one (see the next line), so they find nothing of yours; do neither in the preview.',
  "NO HOST CREDENTIAL (!A469): the preview daemon once found your real `gh` and used your GitHub sign-in. `fy5` (the one place the daemon's environment is built) now starts it with an ALLOW-LIST environment (USER, LOGNAME, PATH, SHELL, TERM, LANG, LC_*, XDG_RUNTIME_DIR, DISPLAY, WAYLAND_DISPLAY and the preview's own FY_*): every other name, so every GH_*/GITHUB_*/GIT_*/SSH_*/AWS_*/AZURE_*/GOOGLE_*/GCLOUD_*/NPM_*/DOCKER_*/ANTHROPIC_*/OPENAI_*/CLAUDE_*/CODEX_* and every *_TOKEN/*_KEY/*_SECRET/*_PASSWORD/*_PASS/*_CREDENTIALS name, and SSH_AUTH_SOCK, never reaches the daemon or a child of it. HOME is an EMPTY 0700 folder (`<home>/no-host-creds/home`; the credential check accepts it with zero entries). Terminals get ZDOTDIR and HISTFILE in their `environment` (terminals.yaml) pointing at `<home>/no-host-creds/zdot`, a 0700 folder that `fy5 daemon start` makes fresh with ONE empty 0600 `.zshrc` (without any zsh startup file, an interactive zsh runs its first-run menu and swallows the keys typed into a terminal the daemon opens; the file reads nothing and holds nothing), so the shells' own files (`.zcompdump*`, `.zsh_history`, `.zsh_sessions`, `.bash_history`) land there and not in the HOME: the credential check tolerates exactly those names in `zdot/`, by name only, and refuses any other, a link, or a changed rc. Only a daemon start writes the rc, never a probe or another verb, so ~/.config/gh, ~/.netrc, ~/.npmrc, ~/.docker, ~/.gitconfig, ~/.git-credentials and ~/.config/git are not found by any lookup through HOME (OpenSSH is the exception, see GAP below); GH_CONFIG_DIR is an empty 0700 folder, GIT_CONFIG_GLOBAL an empty 0600 file, GIT_CONFIG_SYSTEM=/dev/null, GIT_CONFIG_NOSYSTEM=1 and GIT_TERMINAL_PROMPT=0 (no credential helper, no prompt) for the daemon itself. The daemon gives its children only PATH, HOME and (to git and gh) a few tool names such as GH_CONFIG_DIR, so the other variables above, GIT_CONFIG_SYSTEM and GIT_CONFIG_NOSYSTEM included, do not reach a child (the empty HOME does, and a system gitconfig under /etc stays readable); ssh is covered by a shim on the PATH instead: `fy5 daemon start` makes the folder `<home>/no-host-creds/bin` (or, when it exists, checks it is ours, 0700 and not a symlink, and refuses otherwise), writes an `ssh` shim there and puts the folder FIRST on the PATH; anything else left in that folder is kept, and is first on the PATH too. The shim runs the first real `ssh` found on the rest of the PATH, by absolute path (as found by the last start that found a usable one: a start that finds none, or one whose path holds a quote, $, backtick or backslash, keeps the earlier shim, which runs the `ssh` that start recorded and fails with exit 127 if it is gone), with `-F /dev/null -o IdentityFile=none -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes` and its own known_hosts (kept across stops and starts until `clean`) (so git over ssh from the daemon, the board's `ssh -G` and any child that finds `ssh` on the daemon's PATH read no ~/.ssh config and offer no key; a host's key is never trusted, so such a connection fails). `fy5 daemon start` makes the empty HOME, gh folder and git config fresh and `preview.sh stop` removes those three; it never removes the shim or its folder, because the preview's tmux server outlives the daemon and its running ferret panes keep that folder first on their PATH (a shim left after a stop is harmless, it only adds restrictions, and each start that finds a usable `ssh` replaces it atomically). `preview.sh start` proves it after the daemon is up (`preview.sh credential-check` repeats it): no credential-shaped name in the daemon's environment, the stand-ins empty and private, `gh auth status` in that environment says NOT signed in, and `ssh -G` run with the environment a child of the daemon gets (PATH and HOME only) shows `identityfile none`; a miss stops the daemon and exits 1. The preview's harnesses use their own homes under the preview home by design. GAP: this is the environment, not a fence. OpenSSH takes its home from the passwd entry, not HOME, so a process that calls /usr/bin/ssh (or `scp`, or any ssh) by absolute path, or names a key or config by absolute path, can still read ~/.ssh. The shim covers only a child that finds `ssh` on the daemon's PATH: a ferret whose launch sets its own PATH (a Shells part's dev-shell PATH replaces the daemon's and carries no shim folder, and a login shell that rewrites PATH does the same) runs whatever `ssh` that PATH holds, so an openssh in that shell reads ~/.ssh and git over ssh there can use your keys and push as you. A start that finds no usable `ssh` keeps the shim an earlier start wrote, which runs the `ssh` recorded then. That a host key is never trusted holds only for a caller that does not pass `-o StrictHostKeyChecking`: such a caller connects (still with no key, agent or prompt) and the host stays in the shim's known_hosts until `clean`. `preview.sh clean` removes the shim with the preview home: run it only after the preview ferret panes (its tmux server) are gone, or their `ssh` becomes the host one. A process of the preview that opens a real credential file BY ITS ABSOLUTE PATH (for example /home/<you>/.config/gh/hosts.yml) can still read it, because the preview runs as you and the fence unit has not landed (the first line above); on macOS a keychain answers by user, not by environment. To give the board's GitHub watcher a `gh`, copy the gh stub (/tmp/claude-1000/briefs/rebuild/smoke/gh-stub/gh) to `<home>/bin/gh` (mode 0755): the preview's `bin` is first on the daemon's PATH, and the check accepts exactly that file as the preview's own `gh` without asking it.",
  "5.0 reads limits.yaml for launches. The preview writes `enabled: false` (in effect once you run `prepare --owner`; until then the defaults apply), so launches run directly; it does not depend on that alone: the preview daemon also reaches no user systemd manager (two layers), and `preview.sh start` checks both. The kernel runs 5.0's systemd probe with only {PATH, HOME}, so that probe gets no bus at all; the daemon's private XDG_RUNTIME_DIR (a folder in the preview home, with DBUS_SESSION_BUS_ADDRESS dropped) is the second layer. Every launch therefore runs directly, with no slice, scope or `systemctl set-property`. `preview.sh start` asks the probe both ways and refuses to start if either reaches your manager. Do not start the preview daemon any other way, and do not turn limits on in the preview: a daemon that reached your systemd would reset v4's `ferretry_fleet.slice` and per-ferret slices to the 5.0 defaults.",
  "Ferrets whose folder was inside v4's home or v4's worktree folder, inside a worktree v4's ledger lists, or under any `.worktrees` folder lost their folder: they point at an empty `workspace` folder in the preview home, so a resumed one never runs in a live v4 checkout. A preview ferret in a primary checkout shares that checkout with v4's agents: it keeps its folder and CAN change real files there when you resume it.",
  'Every ferret is stopped and nothing resumes by itself. Starting one in the preview starts a new agent; it does not continue the v4 conversation.',
  "An agent with your GitHub credential can still push a `v*` tag. What stops a tag from publishing is cd.yaml's main-only job (the tagged commit must be on main), and it cannot publish from a 5.0 commit made after this guard lands. A v* tag on a 5.0 commit made before this guard would still publish; no agent ever creates or pushes a tag (team rule).",
  'The preview signing key is only as safe as push access to rebuild/5.0: whoever can push that branch can change what the v5 app signs.',
  "`fy5` pins the preview address, so the preview CLI never talks to v4. A tool started OUTSIDE `fy5` (a bare `fy` from your normal shell) is v4's, and is not stopped by anything here.",
  "A login shell finds v4's `fy` first on this box (/etc/profile.d/nix.sh puts the nix profile ahead of the preview's `bin`). The converted home carries the guard `__ETC_PROFILE_NIX_SOURCED=1` plus FY_HOME, FY_PORT and FY_URL for Claude Code ferrets, through `settings.env` (`config/claude-code/settings/fy-preview.yaml`). 5.0's runtime and profile files are strict and hold no `env`, so a settings item is the only place a home can carry one. That item is applied by 5.0 today. CODEX RUNTIMES ARE LEFT OUT of the preview, and each is listed by name in the conversion report: " +
    CODEX_HELD_SENTENCE +
    ". Codex ferrets, and the pack routes and runs that name a held runtime, are held the same way, by name. Do not add a Codex login or runtime to the preview yet (v4's Codex logins are held too). `preview.sh start` refuses to start unless `bash -lc`, `bash -ic` and `zsh -lic` with that environment find the preview's `fy`. Terminals opened in the preview, by you or by a ferret, carry the preview environment: Terminals' own `environment` setting (`config/terminals.yaml`, owner-only: any change waits for you) is passed to every terminal the daemon opens. OWNER STEP: only YOU run `preview.sh prepare --owner`; that flag is your act of accepting the config files the preview wrote or changed (found by comparing with the plain conversion: `config/terminals.yaml`, `config/claude-code/settings/fy-preview.yaml`, the forced `config/limits.yaml`), except any that comes from a v4 file with an unconfirmed edit (each stays held, and the prepare note names every one; confirm the edit in v4, then \`preview.sh clean\` and \`preview.sh prepare --owner\`), and no agent runs prepare for real. `--owner` is the owner's word, not a lock: an agent at your user id could already write these records by hand. Without it none of them is accepted, so terminals open without the preview environment and \`preview.sh start\` stops the daemon. `preview.sh start` proves it on every start by opening a terminal through the daemon's own route and requiring the preview's `fy` and FY_HOME in it (`preview.sh terminal-check` repeats it). A terminal started outside the preview daemon is not covered. The shim `~/.ferretry-v5/bin/fy` refuses `update` and the daemon lifecycle verbs, as `fy5` does.",
  'Harness updates started from the preview (Claude Code or Codex "update") run npm or the native updater on YOUR installed tools. They only run when you ask for them.',
  'The preview daemon asks the user systemd manager one read-only question when it starts (`systemctl --user show-environment`) and runs an `ionice` probe. In the preview the question is answered "no manager" by design (see the limits line): the kernel gives that probe no bus. It changes nothing of v4\'s.',
  "tmux: the preview uses its own socket under its home (<home>/state/terminals/tmux.sock), so it is a different tmux server from v4's.",
  "The lifecycle claim files beside v4's service unit are only written by a lifecycle verb (stop, restart, install, uninstall, reset, update). `fy5` refuses those; `preview.sh proof` checks that none appeared, and compares a content hash of each claim file that existed (they are locks, not credentials).",
  'Names the preview shares with v4 but only reads: /etc/ferretry/loopback-firewall.conf, /run/ferretry/loopback-firewall.json, and the `ferretry_voice.slice` read.',
  "5.0 does not read `browserPorts`, so the preview's browser ports are random. That is harmless; it is only noted so nobody chases it.",
];
