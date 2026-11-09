#!/usr/bin/env bun
/**
 * Inventory the 4.x reference, never a running daemon or a person's FY_HOME.
 *
 * bun scripts/rebuild/parity.ts --source ../rebuild-ref
 * bun scripts/rebuild/parity.ts --source ../rebuild-ref --check
 *
 * Source is parsed, not imported. In particular the Commander walker interprets only syntax and
 * records command builders; action handlers, constructors and host APIs are never executed.
 * Keep the previous TSV: it is the ID/status registry. Existing rows retain both across regeneration.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseSync } from 'oxc-parser';

type Kind = 'R' | 'V' | 'T' | 'S' | 'J' | 'F';
interface Row {
  id: string;
  kind: Kind;
  what: string;
  source: string;
  todayOwner: string;
  owner: string;
  name5: string;
  descriptor: string;
  check: string;
  status: string;
}
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : (args[index + 1] ?? fallback);
};
const root = resolve(import.meta.dir, '../..');
const sourceRoot = resolve(option('--source', join(root, '../rebuild-ref')));
if (sourceRoot === root) throw new Error('--source must be the read-only 4.x reference, not this branch');
const outputDirectory = resolve(option('--out-dir', join(root, 'docs/design')));
const markdownPath = join(outputDirectory, 'rebuild-parity.md');
const tsvPath = join(outputDirectory, 'rebuild-parity.tsv');
const sourceHead = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['-C', sourceRoot, 'ls-files', 'packages'], { encoding: 'utf8' })
  .split('\n')
  .filter(file => /\.[cm]?tsx?$/.test(file) && !/(\/tests?\/|\.test\.|\.spec\.|\.d\.ts$|\/vendor\/)/.test(file))
  .sort();
const digest = createHash('sha256');
const rows: Row[] = [];
const warnings = new Set<string>();
const kindNames: Record<Kind, string> = {
  R: 'HTTP and socket endpoints',
  V: 'fy commands (aliases are separate rows)',
  T: 'MCP and agent tools',
  S: 'App routes, features, panels, settings and sheets',
  J: 'Daemon job, timer and watcher sites',
  F: 'Stored file/path declarations',
};
const owners = [
  'kernel',
  'gate',
  'vault',
  'ferrets',
  'asks',
  'access',
  'connections',
  'updates',
  'terminals',
  'browsers',
  'claude-code',
  'codex',
  'logins',
  'runtimes',
  'accounts',
  'conversation',
  'agenda',
  'projects',
  'board',
  'packs',
  'warden',
  'usage',
  'lessons',
  'voice',
  'catalogs',
  'mcp',
  'skills',
  'shells',
  'layouts',
  'onboarding',
  'tidy',
  'cli',
  'app',
];
const core = new Set(['kernel', 'gate', 'vault', 'ferrets', 'asks']);
const packagePath = (owner: string) =>
  owner === 'app' || owner === 'cli'
    ? `packages/${owner}`
    : `packages/${core.has(owner) ? 'core' : 'plugins'}/${owner}`;
const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
const stripLine = (source: string) => source.replace(/:\d+$/, '');
const rowKey = (row: Pick<Row, 'kind' | 'what' | 'source'>) => `${row.kind}\t${row.what}\t${stripLine(row.source)}`;
const moduleName = (file: string) =>
  file.match(/\/runtime\/mounts\/([^/.]+)/)?.[1] ??
  file.match(/\/(?:lib|adapters|modules|features)\/([^/]+)/)?.[1]?.replace(/\.tsx?$/, '') ??
  'host';

/** Ordered source/semantic ownership rules, transcribed from redesign §8 and split responsibilities in §2.3. */
function ownerOf(file: string, what = ''): string {
  const text = `${what} ${file}`.toLowerCase();
  const semantic = what
    .toLowerCase()
    .replace(/^(?:component|feature|screen|route|settings\/navigation|timer\/watcher|job\/lifecycle arm) /, '')
    .replace(/<[^>]+>|\[[^\]]+\]/g, '');
  const source = file.replace('/runtime/mounts/', '/mounts/');
  const rules: [RegExp, string][] = [
    [
      /account[._-](hint|propose)|sign-in|signin-rule|copy-plan|secure[_-](copy|paste|discard)|task_plan|task-plans|\/accounts(?:\/|\b)|\/secrets\/account/,
      'accounts',
    ],
    [/terminal[_.:/ -]|\/terminals|console\/input|tmux|cgroups|processes/, 'terminals'],
    [/browser[_.:/ -]|\/browsers|firewall/, 'browsers'],
    // Phone approvals ride the input-requests module today but are Accounts' in 5.0 (its manifest declares the routes).
    [/phone[-_ ]?approval/i, 'accounts'],
    [
      /input[_.-](wait|cancel)|request[_-]input|input-requests|quarantine|\/secret(?:s|\b)|secret[_ -](set|list|rm)|secrets\.(json|key)|redactor/,
      'vault',
    ],
    [/task[_. -]|\/board|board-|merge-gate|workflow|lane[-/ ]|tasks\.json/, 'board'],
    [
      /\/v1\/shared\/|\/catalog|catalog[_ -]|shared-catalog|catalog-members|catalog-links|catalog-install|catalog-share/,
      'catalogs',
    ],
    [/\bmcp\b|mcp[_-]/, 'mcp'],
    [/lesson|learning/, 'lessons'],
    [/warden|\bmonitor\b/, 'warden'],
    [/(?:^|[\/ ._-])packs?(?:[\/ ._-]|$)|subtree|sub-ferret|jev-spend|clean-up-guide/, 'packs'],
    [/onboard|setup-journey|machine-setup/, 'onboarding'],
    [/pricing|quota|usage|analytics|budget|performance|compaction-history/, 'usage'],
    [/stt|voice|dictation|speech|transcription-log|speedup/, 'voice'],
    [
      /passkey|pairing|\bfy pair|\bfy device|\bfy grant|\/devices|\/grants|step-up|unlock|(?:^|\/)push(?:\/|\.)|push-subscription|push-keys/,
      'access',
    ],
    [/tunnel|webrtc|carrier|\/relay|connection-preference|connection-drops/, 'connections'],
    [/update|whats-new|release-notice/, 'updates'],
    [/credential|fleet-login|provider-probe|local-model|models[./ -]|\/logins|codex-login|claude-login/, 'logins'],
    [/instruction/, 'ferrets'],
    [/runtimes?|profiles?|presets?|components?|fleet-catalog|\/fleet|routing/, 'runtimes'],
    [/project/, 'projects'],
    [/agenda|attention|notification|\bfy notify|buzz/, 'agenda'],
    [/audit|security|api-token|warden-token|capabilit|socket-ticket|\/api\//, 'gate'],
    [/skill/, 'skills'],
    [/shells\//, 'shells'],
    [/housekeeping|\btidy\b|scratch/, 'tidy'],
    [
      /transcript|attachments?|renders?|shared-draft|work-search|search_work|message|queue|turns|question|\/imports|imported-history|\bfy import|\bfy link|\bfy send|\bfy answer|\bfy history|\bfy render/,
      'conversation',
    ],
  ];
  // Distinguish the two harness halves before their shared source-directory fallback.
  if (/\/v1\/health|\/healthz|\/v1\/config\/|^fy config\b/.test(semantic)) return 'kernel';
  if (/^(?:ws )?get \/v1\/events\b/.test(semantic)) return 'kernel';
  if (/\/fleet\/login(?:\/|\b)|\/fleet\/presets/.test(semantic)) return 'logins';
  if (/\/fleet\/setup/.test(semantic)) return 'onboarding';
  if (/\/diagnostics\/profile/.test(semantic)) return 'usage';
  if (/\/skill-installs/.test(semantic)) return 'skills';
  // The Add skills page lists the skills of the catalogs this device subscribes to: Catalogs' page, reached from Skills' slot.
  if (/add-skills-page\.tsx/.test(file) || what === "screen 'add-skills'") return 'catalogs';
  if (/agent-pins\.json/.test(semantic)) return 'ferrets';
  if (/\bboard(?:[ ._-]|$)|boardimporter|cardstarts|unfiledrefiler/.test(semantic)) return 'board';
  if (/sweepdeadlines/.test(semantic)) return 'asks';
  // The input-request sweep is Vault's `inputs-sweep` job in 5.0 (lead ruling, ports-pending exit tidy); the word
  // `housekeeping` in today's function name is not Tidy's.
  if (/startinputhousekeeping|sweepinputrequests/.test(semantic)) return 'vault';
  if (/sendtracking|sendreproof|subsystems\.observer/.test(semantic)) return 'conversation';
  if (/\/secrets\/logins/.test(semantic)) return 'accounts';
  if (
    /accounts?|sign.?ins?|secure-copy|copyplans|signinrule/.test(semantic) &&
    !/credential|login-secrets/.test(semantic)
  )
    return 'accounts';
  if (/secrets?(?:[./ _-]|$)/.test(semantic)) return 'vault';
  if (/terminal|tmux/.test(semantic)) return 'terminals';
  if (/browser/.test(semantic)) return 'browsers';
  if (/devices|passkey/.test(semantic)) return 'access';
  if (/settings panel (?:grants|security-log)|fy daemon config/.test(semantic)) return 'gate';
  if (/resource-limits|limits\.yaml|lineage/.test(semantic)) return 'ferrets';
  if (/settings panel (?:files|doctor|host-checks)/.test(semantic)) return 'kernel';
  if (/settings panel about/.test(semantic)) return 'updates';
  if (/agent-clis/.test(semantic)) return 'claude-code';
  if (
    /\bfy (?:new|start|stop|ps|status|rename|resume|restart|wait|stream|interrupt|migrate|session)\b/.test(semantic) &&
    !/subtree/.test(semantic)
  )
    return 'ferrets';
  if (/\/v1\/recommend|\bfy recommend|\bfy fleet\b|\bfy guide\b/.test(semantic)) return 'packs';
  if (/agenda-mode|agenda\/mode/.test(semantic)) return 'agenda';
  if (/\.toml|codex.*(?:settings|instructions)|(?:^|\/)codex\//.test(semantic)) return 'codex';
  if (/login-entries|account-defaults|login-secrets/.test(semantic))
    return /secrets/.test(semantic) ? 'vault' : 'accounts';
  if (/agenda-seen/.test(semantic)) return 'agenda';
  if (/agenda|attention/.test(semantic) && !/\bfy agenda|\bfy attention|notification|nudge/.test(semantic))
    return 'asks';
  if (/\bfy (?:copy|plan|rules|account)(?:\s|$)|\bsecure_list\b/.test(semantic)) return 'accounts';
  if (/revoke-credential/.test(semantic)) return 'ferrets';
  if (/\bfy daemon profile\b/.test(semantic)) return 'usage';
  if (/daemon-identity\.json/.test(semantic)) return 'kernel';
  if (/archived-sessions|callsigns|auto-resume|\/sessions\/(?:\{[^}]+\}\/)?(?:config|state)\.json/.test(semantic))
    return 'ferrets';
  if (/session-version/.test(semantic)) return 'ferrets';
  if (/push\.json|push-vapid/.test(semantic)) return 'access';
  if (/fy input\b/.test(semantic)) return 'vault';
  // Ferrets declares the working-tree viewer (`/v1/ferrets/:ferretId/fs*`, read through WorkFolders, S47) and the pin
  // board (`/v1/ferrets/:ferretId/pins`), and holds the one-writer conversation lease `fy history claim` takes.
  if (/fy (?:fs|files|pin|history)\b|pins\.json/.test(semantic)) return 'ferrets';
  // A ferret's screen is the Terminals' (its pane); its recorded events are the Ferrets' (lead ruling, port-conversation
  // r2 #4). Conversation declares neither.
  if (/\/sessions\/:sessionid\/snapshot\b|\bfy snapshot\b/.test(semantic)) return 'terminals';
  if (/\/sessions\/:sessionid\/events\b|\bfy events\b/.test(semantic)) return 'ferrets';
  if (/fy harness\b|statusline/.test(semantic)) return /codex/.test(semantic) ? 'codex' : 'claude-code';
  if (/config_(?:read|write|validate)/.test(semantic)) return 'kernel';
  if (/harness.*codex|codex.*harness/.test(semantic)) return 'codex';
  if (/harness.*claude/.test(semantic)) return 'claude-code';
  for (const [pattern, owner] of rules) if (pattern.test(semantic)) return owner;
  if (/\/agenda\//.test(source) || /\/mounts\/agenda/.test(source)) return 'asks';
  if (/\/features\/fleet\/shell\//.test(source)) return 'app';
  // The Codex rollout watch sits under today's housekeeping folder but is Codex's, not Tidy's (same ruling).
  if (/codex-rollout/.test(source)) return 'codex';
  for (const [pattern, owner] of rules) if (pattern.test(source)) return owner;
  if (/agent-files|harness-update/.test(text)) return /codex/.test(text) ? 'codex' : 'claude-code';
  if (/session|ferret|auto-resume|worktree|fork|handover|\bname/.test(text.replace(/packages\//g, '')))
    return 'ferrets';
  if (/config|paths|storage|journal|state-home|layout-version|daemon|runtime\/|fyd\.ts/.test(text)) return 'kernel';
  if (file.startsWith('packages/pwa/')) return /appearance|theme|layout/.test(text) ? 'layouts' : 'app';
  if (file.startsWith('packages/cli/')) return 'cli';
  return 'UNPLACED';
}

function renamed(what: string): string {
  return what
    .replace(/\/v1\/sessions(?=\/|\b)/g, '/v1/ferrets')
    .replace(/^fy task\b/, 'fy card')
    .replace(/^fy card status\b/, 'fy card progress')
    .replace(/^fy (?:credentials?|login)\b/, 'fy login')
    .replace(/^fy learning\b/, 'fy lesson')
    .replace(/^fy harness update(?: \[harness\])?$/, 'fy harness {claude-code|codex} update')
    .replace(/^fy migrate\b/, 'fy ferret move')
    .replace(/^fy import conversations\b/, 'fy link')
    .replace(/--ping\b/g, '--buzz')
    .replace(/\btask_plan\b/g, 'card_plan');
}
/**
 * Owner decision !A466 (2026-11-08): the local skill copy is gone from 5.0, with the "from this machine" group of the Add
 * skills page. The page itself stays, as Catalogs' (its catalogs group), so only the machine group's file is removed.
 */
const REMOVED_BY_OWNER = 'removed by design (owner decision !A466, 2026-11-08: the local skill copy is gone)';
const OWNER_REMOVED = /local-skill-install|machine-skills-group\.tsx/;
function removal(kind: Kind, what: string, file: string, detail: string): string | undefined {
  if (OWNER_REMOVED.test(file) && !(kind === 'V' && what === 'fy skill')) return REMOVED_BY_OWNER;
  if (/\balias of\b/.test(detail)) return 'removed by design (§1.4: no aliases)';
  if (
    kind === 'F' &&
    /layout-version|carriers-migration\.json|board-import\.json|legacy-wire-use\.json|operator-password\.json|\.migrated\b|\.v[12]\.json|\.before-[^/]+\.json|(?:^|\/)tasks\.json|attention[^/]*\.json|fleet\/config\.yaml|\.migration-journal|pack-routing-migration-|(?:^|\/)daemon\.json|(?:^|\/)routing\.json|migration[^/]*\.json/.test(
      what,
    )
  )
    return 'removed by design (§9.2: old files/markers; feature moves to its owner)';
  // britnee ruling #6: v4's boot-time routing conversion is the home converter's packs step (proved by the converter's
  // test J-0052); the daemon runs no conversion.
  // britnee ruling #4: F-0168 is a duplicate of F-0377 (config/machine.yaml is no file in 5.0: the converter splits it
  // key by key over its owners' files, and F-0377's test proves each key has a schema there). F-0377 stays ticked.
  if (kind === 'F' && what === 'FY_HOME/config/machine.yaml')
    return 'removed by design (duplicate of F-0377: machine.yaml is split key by key over its owners’ files, proved there)';
  if (kind === 'J' && /new RoutingMigration\(/.test(what))
    return "removed by design (§9.1, §9.2: removed from the daemon; the v4-to-v5 converter's packs step carries models-guide.yaml and pack.yaml, proved by its test J-0052)";
  if (/legacy|migration/.test(file) && !/session-migrate|session\/migrat|lib\/migration\/commands/.test(file)) {
    if (kind === 'J') return 'removed by design (§9.1, §9.2: one-shot conversion/old-format work)';
  }
  if (kind === 'S' && /legacy-tasks-redirect|version-skew|feature-unavailable|daemon-features/.test(what + file))
    return 'removed by design (§9.6: old routes/probes/fallback UI)';
  if (kind === 'V' && /fy daemon adopt\b/.test(what)) return 'removed by design (§9.1, §9.2: old home adoption)';
  if (kind === 'V' && what === 'fyd --config')
    return 'removed by design (5.0 reads configuration from $FY_HOME/config/; fyd refuses --config by name, exit 64)';
  if (kind === 'V' && what === 'fy import')
    return 'removed by design (§1.4: imports are links; its one verb is `fy link`)';
  if (kind === 'R' && /legacy-tasks/.test(file)) return 'removed by design (§9.1, §9.2: per-ferret tasks/old readers)';
  if (kind === 'F' && (/\/cgroups\//.test(what) || /\/cgroups\/legacy-documents/.test(file)))
    return 'removed by design (§9.2: old cgroups directory)';
  if (kind === 'F' && /fleet\/config\.yaml|account\/document\.ts/.test(what + file))
    return 'removed by design (§9.2: fleet/config.yaml)';
  return undefined;
}
/**
 * Rows the word rules above place with Runtimes ("runtime", "fleet", "component" in a name) but whose code is another
 * owner's in 5.0 (britnee ruling, parity-runtimes round 1: re-owned, none removed). Keyed by ROW ID, so a later row from
 * the same source file keeps the owner the rules gave it; `applyReowned` refuses an id the inventory does not hold.
 * J-0052 (the boot-time routing conversion) is no longer a REOWNED row at all in effect: `removal()` marks it removed
 * from the daemon, the v4-to-v5 converter's packs step doing that job (britnee ruling #6).
 */
const REOWNED: Readonly<Record<string, string>> = {
  // Pack routing conversion at boot (the v4-to-v5 converter's packs step is the nearest owner).
  'J-0052': 'packs',
  // Activity timers, the ordered log writer and the bundled worker host and probe: the kernel's clock, jobs and workers.
  'J-0093': 'kernel',
  'J-0153': 'kernel',
  'J-0161': 'kernel',
  'J-0165': 'kernel',
  'J-0169': 'kernel',
  'J-0175': 'kernel',
  // The session worker's pacing and backstop timers: Ferrets' own worker (the kernel only supplies `after`).
  'J-0176': 'ferrets',
  // The relay carrier's reconnect scheduler is Connections'.
  'J-0177': 'connections',
  // The housekeeping pass trigger: analytics ingestion's nudge plus its slow backstop is Usage's.
  'J-0227': 'usage',
  // The credentials' usage reading, kept current by file events: Logins'. J-0096 (a watched document is read again
  // only when it changed) is Logins' own: its login files are read through the kernel's watched configuration.
  'J-0096': 'logins',
  'J-0232': 'logins',
  'J-0233': 'logins',
  'J-0234': 'logins',
  // The transcript follower: each harness implements `TranscriptReader.follow` (Claude's is claude-code's).
  'J-0237': 'claude-code',
  'F-0006': 'skills',
  'F-0018': 'cli',
  // The shared-history lease lock: the lease store stays Conversation's.
  'F-0023': 'conversation',
  'F-0027': 'kernel',
  'F-0029': 'kernel',
  'F-0030': 'kernel',
  'F-0034': 'kernel',
  'F-0046': 'kernel',
  'F-0096': 'kernel',
  // Screens of the conversation, the files tab and the session pages.
  'S-0064': 'conversation',
  'S-0111': 'conversation',
  'S-0115': 'conversation',
  'S-0134': 'conversation',
  'S-0102': 'ferrets',
  'S-0103': 'ferrets',
  'S-0157': 'ferrets',
  'S-0160': 'ferrets',
  'S-0167': 'ferrets',
  'S-0232': 'ferrets',
  // One machine's outage sheet: the outage and its attempt count are Connections'.
  'S-0145': 'connections',
  // The fleet event socket is declared by Ferrets (packages/core/ferrets/manifest.ts), not the kernel.
  'R-0424': 'ferrets',
  // The open-url route is served by Browsers (daemon/open-url/routes.ts).
  'R-0401': 'browsers',
  // britnee ruling D6 (2026-11-09): the kernel-filed rows whose behaviour another plugin owns in 5.0 are RE-OWNED, not
  // removed; each stays `[ ]` until its owner ticks it with a test. None of them is "removed by design".
  // The staged-file sweep is the agent browser's own upload copies (browsers/daemon/tools/adapters/staged-files.ts).
  'J-0008': 'browsers',
  'J-0097': 'browsers',
  'J-0126': 'browsers',
  // Auto-resume, the session attachments (the PDF unlock worker and the unlocked copy's eviction), the inline observer,
  // the fleet event socket's timer, the send pause and the write-behind session index: Ferrets'.
  'J-0016': 'ferrets',
  'J-0062': 'ferrets',
  'J-0193': 'ferrets',
  'J-0106': 'ferrets',
  'J-0137': 'ferrets',
  'J-0140': 'ferrets',
  'J-0159': 'ferrets',
  // The board sweeps and the GitHub watcher are Board's.
  'J-0019': 'board',
  'J-0025': 'board',
  'J-0065': 'board',
  // The catalog members' sweep and the member join gate's timer are Catalogs'.
  'J-0022': 'catalogs',
  'J-0136': 'catalogs',
  // The agent clearer's sweep and the agenda's nudge timer are Agenda's.
  'J-0009': 'agenda',
  'J-0134': 'agenda',
  // The fleet refresh pass and the fleet reading's timer keep a credential's usage current: Logins' (as J-0232 to J-0234).
  'J-0067': 'logins',
  'J-0068': 'logins',
  'J-0135': 'logins',
  // The cgroup read is Terminals' user-slice check; the package install is Runtimes' tool install.
  'J-0168': 'terminals',
  'J-0125': 'runtimes',
  // The Codex runtime's credential link inside its home, and the no-questions import verb: Runtimes'.
  'F-0079': 'runtimes',
  'V-0232': 'runtimes',
  // The machine screens the kernel has no app half for: each drawn by the plugin or shell that owns it.
  'S-0107': 'access',
  'S-0223': 'accounts',
  'S-0370': 'app',
  'S-0381': 'app',
  'S-0371': 'conversation',
  'S-0382': 'catalogs',
  'S-0373': 'onboarding',
  'V-0241': 'onboarding',
};

const SHELL_DAEMON_VERBS: ReadonlySet<string> = new Set([
  'fy daemon',
  'fy daemon install',
  'fy daemon logs',
  'fy daemon reset',
  'fy daemon restart',
  'fy daemon start',
  'fy daemon status',
  'fy daemon stop',
  'fy daemon uninstall',
  'fy daemon which',
]);
const SHELL_STORAGE_FILES: ReadonlySet<string> = new Set([
  'packages/cli/src/adapters/daemon/lifecycle-lock.ts',
  'packages/cli/src/lib/daemon/layout.ts',
]);
/** The unit test file that proves a row: the owner's parity file for its kind, or the shell's own for what it owns. */
function checkOf(kind: Kind, what: string, file: string, actualOwner: string): string {
  return kind === 'V' && what === 'fy daemon update'
    ? 'packages/cli/tests/unit/update/shell.test.ts'
    : // The daemon process verbs are the fy shell's, which a kernel test may not import (context-imports).
      kind === 'V' && SHELL_DAEMON_VERBS.has(what)
      ? 'packages/cli/tests/unit/parity/daemon-verbs.test.ts'
      : // The lifecycle claim and the daemon lock's place in the state home are the shell's own files.
        kind === 'F' && actualOwner === 'kernel' && SHELL_STORAGE_FILES.has(file)
        ? 'packages/cli/tests/unit/parity/storage.test.ts'
        : // The sweep arm is proved by name in Vault's composition test (it drives `inputs-sweep`), not a jobs file.
          kind === 'J' && /\.startInputHousekeeping\.sweepInputRequests$/.test(what)
          ? 'packages/core/vault/tests/unit/daemon/composition.test.ts'
          : // The tmux release reader's bound (J-0198) is proved where the reader is: kill at the bound, nothing left running.
            kind === 'J' && file.endsWith('/adapters/tmux/tmux-release-reader.ts')
            ? 'packages/plugins/terminals/tests/unit/daemon/tmux/release-and-scrub.test.ts'
            : kind === 'R'
              ? 'descriptor-parity'
              : `${packagePath(actualOwner)}/tests/unit/parity/${{ V: 'commands', T: 'agent-tools', S: 'app', J: 'jobs', F: 'storage' }[kind]}.test.${kind === 'S' ? 'tsx' : 'ts'}`;
}
function add(kind: Kind, what: string, file: string, line: number, descriptor = '', owner?: string) {
  let actualOwner = owner ?? ownerOf(file, what);
  if (kind === 'S' && actualOwner === 'asks') actualOwner = 'agenda';
  if (kind === 'F' && /\/channel\/|inbox\.jsonl|outbox\.jsonl|sends\.jsonl|answers\.jsonl/.test(what))
    actualOwner = 'conversation';
  const name5 = /^fy component\b/.test(what)
    ? renamed(what).replace(
        /^fy component/,
        'per-kind command: mcp/skill/shell/instruction/profile/runtime/model-set/harness settings/hooks (§1.4)',
      )
    : renamed(what);
  const check = checkOf(kind, what, file, actualOwner);
  rows.push({
    id: '',
    kind,
    what: compact(what),
    source: `${file}:${line}`,
    todayOwner: moduleName(file),
    owner: actualOwner,
    name5,
    descriptor: compact(descriptor),
    check,
    status: removal(kind, what, file, descriptor) ?? '[ ]',
  });
}

/**
 * A syntax node as `oxc-parser` returns it (ESTree with the TypeScript extensions). The tree is only ever READ by shape;
 * nothing in it is executed. `parent` is set by `normalize`. The index signature is `any` on purpose: the generator
 * walks dozens of node shapes by field name, and a type per shape would be a second copy of the parser's own.
 */
type N = { type: string; start: number; end: number; parent?: N; [key: string]: any };
interface Source {
  text: string;
  lines: number[];
}
interface Module {
  file: string;
  ast: N;
  source: string;
  declarations: Map<string, N[]>;
  imports: Map<string, [string, string]>;
}
const modules = new Map<string, Module>();
const sources = new WeakMap<N, Source>();

const isNode = (value: unknown): value is N =>
  typeof value === 'object' && value !== null && typeof (value as N).type === 'string';
/** `a?.b` is a `ChainExpression` wrapper in ESTree and nothing extra in the TypeScript tree this generator was built on. */
const unchain = (node: N): N => (node.type === 'ChainExpression' ? unchain(node.expression) : node);
/** Sets every `parent` and removes the chain wrappers. */
function normalize(root: N) {
  const pending: N[] = [root];
  for (let node = pending.pop(); node; node = pending.pop()) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      if (Array.isArray(value))
        value.forEach((item, index) => {
          if (!isNode(item)) return;
          const child = unchain(item);
          value[index] = child;
          child.parent = node;
          pending.push(child);
        });
      else if (isNode(value)) {
        const child = unchain(value);
        node[key] = child;
        child.parent = node;
        pending.push(child);
      }
    }
  }
}
/** Child nodes in source order (the order the TypeScript tree visits them). A shorthand property is one node. */
function children(node: N): N[] {
  if (node.type === 'Property' && node.shorthand) return [node.value];
  const out: N[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    } else if (isNode(value)) out.push(value);
  }
  return out.sort((a, b) => a.start - b.start);
}
function walk(node: N, visit: (node: N) => void) {
  visit(node);
  for (const child of children(node)) walk(child, visit);
}
function parse(file: string): Module {
  const cached = modules.get(file);
  if (cached) return cached;
  const source = readFileSync(join(sourceRoot, file), 'utf8');
  const ast = parseSync(file, source, {
    lang: file.endsWith('tsx') ? 'tsx' : 'ts',
    sourceType: 'module',
    astType: 'ts',
  }).program as unknown as N;
  normalize(ast);
  const lines = [0];
  for (let index = source.indexOf('\n'); index >= 0; index = source.indexOf('\n', index + 1)) lines.push(index + 1);
  sources.set(ast, { text: source, lines });
  const mod: Module = { file, ast, source, declarations: new Map(), imports: new Map() };
  modules.set(file, mod);
  // Bun 1.3.x erases calls to a function named declare (read as the TS modifier), so it is not called that.
  const recordDeclaration = (name: string, node: N) => {
    const list = mod.declarations.get(name) ?? [];
    list.push(node);
    mod.declarations.set(name, list);
  };
  walk(ast, node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') recordDeclaration(node.id.name, node);
    else if (isFunctionDeclaration(node) && node.id) recordDeclaration(node.id.name, node);
    if (isFunctionLike(node))
      for (const parameter of node.params as N[]) {
        const name = bindingTarget(parameter);
        if (name.type === 'Identifier') recordDeclaration(name.name, name);
      }
    if (node.type === 'ImportDeclaration' && isStringLiteral(node.source)) {
      const path = node.source.value as string;
      for (const specifier of node.specifiers as N[]) {
        if (specifier.type === 'ImportDefaultSpecifier') mod.imports.set(specifier.local.name, [path, 'default']);
        else if (specifier.type === 'ImportSpecifier')
          mod.imports.set(specifier.local.name, [path, nameOf(specifier.imported)]);
      }
    }
  });
  return mod;
}

const FUNCTION_LIKE = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'TSDeclareFunction',
  'TSEmptyBodyFunctionExpression',
]);
const isFunctionLike = (node: N) => FUNCTION_LIKE.has(node.type);
const isFunctionDeclaration = (node: N) => node.type === 'FunctionDeclaration' || node.type === 'TSDeclareFunction';
const isStringLiteral = (node: N) => node.type === 'Literal' && typeof node.value === 'string';
const isNumericLiteral = (node: N) => node.type === 'Literal' && typeof node.value === 'number';
/** A string literal or a template with no substitutions. */
const isStringLike = (node: N) =>
  isStringLiteral(node) || (node.type === 'TemplateLiteral' && node.expressions.length === 0);
/** A template with substitutions. */
const isTemplateExpression = (node: N) => node.type === 'TemplateLiteral' && node.expressions.length > 0;
const cooked = (element: N): string => element.value.cooked ?? element.value.raw;
const stringValue = (node: N): string => (node.type === 'Literal' ? (node.value as string) : cooked(node.quasis[0]));
/** The text pieces of a template: its head, then each substitution with the text that follows it. */
const templateHead = (node: N): string => cooked(node.quasis[0]);
const templateSpans = (node: N): { expression: N; text: string }[] =>
  (node.expressions as N[]).map((expression, index) => ({ expression, text: cooked(node.quasis[index + 1]) }));
const isPropertyAccess = (node: N) => node.type === 'MemberExpression' && !node.computed;
const isElementAccess = (node: N) => node.type === 'MemberExpression' && node.computed;
const memberName = (node: N): string =>
  node.property.type === 'PrivateIdentifier' ? `#${node.property.name}` : node.property.name;
const isTrue = (node: N) => node.type === 'Literal' && node.value === true;
const isFalse = (node: N) => node.type === 'Literal' && node.value === false;
/** `export function f` is a statement of its own in the TypeScript tree, and an export wrapper here. */
const statementOf = (statement: N): N =>
  statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement;
const nameOf = (node: N): string => (node.type === 'Literal' ? String(node.value) : node.name);

type Property = 'assign' | 'shorthand' | 'spread' | 'method' | 'accessor';
/** What an object-literal member is, in the words the TypeScript tree used. Anything else is not an object member. */
function propertyKind(node: N): Property | undefined {
  if (node.type === 'SpreadElement') return 'spread';
  if (node.type !== 'Property' || node.parent?.type !== 'ObjectExpression') return undefined;
  if (node.kind !== 'init') return 'accessor';
  return node.method ? 'method' : node.shorthand ? 'shorthand' : 'assign';
}
/** A member that carries a name (every object member but a spread). */
const hasName = (node: N) => node.type === 'Property';
const keyName = (node: N): string => propName(node.key, node.computed);
/** `name: value`, not shorthand, not a method. */
const isPropertyAssignment = (node: N) => propertyKind(node) === 'assign';
const isShorthandAssignment = (node: N) => propertyKind(node) === 'shorthand';
const isMethodDeclaration = (node: N) =>
  propertyKind(node) === 'method' ||
  ((node.type === 'MethodDefinition' || node.type === 'TSAbstractMethodDefinition') && node.kind === 'method');
/** The binding a parameter or element introduces, without its default or rest wrapper. */
function bindingTarget(node: N): N {
  if (node.type === 'AssignmentPattern') return node.left;
  if (node.type === 'RestElement') return node.argument;
  if (node.type === 'TSParameterProperty') return bindingTarget(node.parameter);
  return node;
}
function bindingDefault(node: N): N | undefined {
  if (node.type === 'AssignmentPattern') return node.right;
  if (node.type === 'TSParameterProperty') return bindingDefault(node.parameter);
  return undefined;
}

const rootOf = (node: N): N => {
  let current = node;
  while (current.parent) current = current.parent;
  return current;
};
const sourceOf = (node: N): Source => sources.get(rootOf(node))!;
function lineOf(node: N): number {
  const { lines } = sourceOf(node);
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lines[middle]! <= node.start) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}
const textOf = (node: N | null | undefined) => (node ? compact(sourceOf(node).text.slice(node.start, node.end)) : '');
/** A binding's own text. A parser that widens an identifier to its type annotation is read as the bare name. */
function bindingText(node: N): string {
  if (node.type === 'Identifier') return node.name;
  const annotation = node.typeAnnotation as N | null | undefined;
  return compact(sourceOf(node).text.slice(node.start, annotation ? annotation.start : node.end));
}
function unwrap(node: N): N {
  return node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSNonNullExpression'
    ? unwrap(node.expression)
    : node;
}
function propName(node: N | null | undefined, computed = false): string {
  if (!node || computed) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number'))
    return String(node.value);
  return '';
}
function enclosingScope(node: N): N | undefined {
  let current = node.parent;
  while (current && !isFunctionLike(current) && current.type !== 'Program') current = current.parent;
  return current;
}
function declaration(mod: Module, name: string, from: N): N | undefined {
  const candidates = mod.declarations.get(name) ?? [];
  const scopes: N[] = [];
  let current: N | undefined = from;
  while (current) {
    if (isFunctionLike(current) || current.type === 'Program') scopes.push(current);
    current = current.parent;
  }
  const scopeOf = (candidate: N) => scopes.indexOf(enclosingScope(candidate) as N);
  return candidates
    .filter(candidate => scopes.includes(enclosingScope(candidate) as N))
    .sort((a, b) => scopeOf(a) - scopeOf(b) || b.start - a.start)[0];
}
function importedFile(mod: Module, path: string): string | undefined {
  let base: string;
  if (path.startsWith('.')) base = relative(sourceRoot, resolve(sourceRoot, dirname(mod.file), path));
  else if (path.startsWith('@ferretry/protocol'))
    base = `packages/protocol/src/${path === '@ferretry/protocol' ? 'lib/index.ts' : path.replace('@ferretry/protocol/', 'lib/')}`;
  else if (path.startsWith('@ferretry/fleet'))
    base = `packages/fleet/src/${path === '@ferretry/fleet' ? 'lib/index.ts' : path.replace('@ferretry/fleet/', 'lib/')}`;
  else return;
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(
    file => existsSync(join(sourceRoot, file)) && statSync(join(sourceRoot, file)).isFile(),
  );
}

/** Small static expression reader for route descriptors and declaration constants. Unknowns remain source text. */
function literal(node: N | null | undefined, mod: Module, seen = new Set<N>()): unknown {
  if (!node || seen.has(node)) return undefined;
  node = unwrap(node);
  seen = new Set(seen).add(node);
  if (isStringLike(node) || isNumericLiteral(node)) return isNumericLiteral(node) ? node.value : stringValue(node);
  if (isTrue(node)) return true;
  if (isFalse(node)) return false;
  if (node.type === 'Identifier') {
    const decl = declaration(mod, node.name, node);
    if (decl && decl.type === 'VariableDeclarator') return literal(decl.init, mod, seen);
    const imported = mod.imports.get(node.name);
    const file = imported && importedFile(mod, imported[0]);
    if (file) {
      const target = parse(file);
      const decl = target.declarations.get(imported![1])?.[0];
      if (decl && decl.type === 'VariableDeclarator') return literal(decl.init, target, seen);
      // Public contracts often re-export the constant through an index barrel.
      const exported = lookup(imported![1], target, moduleEnv(target));
      if (
        exported !== undefined &&
        !(exported instanceof Cmd) &&
        !(typeof exported === 'object' && exported !== null && 'fn' in exported)
      )
        return exported;
    }
    return undefined;
  }
  if (node.type === 'ArrayExpression')
    return (node.elements as (N | null)[]).map(element => literal(element, mod, seen));
  if (node.type === 'ObjectExpression') {
    const result: Record<string, unknown> = {};
    for (const property of node.properties as N[]) {
      switch (propertyKind(property)) {
        case 'assign':
          result[keyName(property)] = literal(property.value, mod, seen) ?? textOf(property.value);
          break;
        case 'shorthand':
          result[property.key.name] = literal(property.value, mod, seen) ?? property.key.name;
          break;
        case 'spread':
          Object.assign(result, literal(property.argument, mod, seen));
          break;
        case 'method':
          result[keyName(property)] = '<handler>';
          break;
      }
    }
    return result;
  }
  if (isPropertyAccess(node)) {
    const target = literal(node.object, mod, seen);
    if (target && typeof target === 'object') return (target as Record<string, unknown>)[memberName(node)];
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = literal(node.left, mod, seen);
    const right = literal(node.right, mod, seen);
    if (left !== undefined && right !== undefined) return `${left}${right}`;
  }
  return undefined;
}
function valueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// Routes: declarations only. Audit fragments deliberately do not count as duplicate live routes.
function routes(mod: Module) {
  walk(mod.ast, node => {
    if (node.type !== 'ObjectExpression') return;
    const keys = new Set((node.properties as N[]).map(property => (hasName(property) ? keyName(property) : '')));
    if (!keys.has('path') || (!keys.has('handle') && !keys.has('accept'))) return;
    const data = literal(node, mod) as Record<string, unknown>;
    if (!data.method || !data.path) return;
    const socket = keys.has('accept');
    const descriptor = ['minimum', 'caller', 'capability', 'privilegedOnly', 'unlockExempt', 'wardenRemedy'].map(
      key =>
        `${key}=${valueText(data[key] ?? (key === 'privilegedOnly' || key === 'unlockExempt' ? false : key === 'capability' || key === 'wardenRemedy' ? 'none' : 'not declared'))}`,
    );
    if (keys.has('needs')) descriptor.push(`member.needs=${valueText(data.needs)} (separate member admission table)`);
    for (const key of ['consultsGrants', 'freshStepUp', 'stepUp', 'available'])
      if (data[key] !== undefined) descriptor.push(`${key}=${valueText(data[key])}`);
    add('R', `${socket ? 'WS ' : ''}${data.method} ${data.path}`, mod.file, lineOf(node), descriptor.join('; '));
  });
}

// Commander syntax interpreter. None of these objects is a real Command or a production dependency.
class Cmd {
  flags = new Set<string>(['-h, --help']);
  args: string[] = [];
  aliases: string[] = [];
  children: Cmd[] = [];
  description = '';
  source = '';
  parent?: Cmd;
  constructor(readonly name: string) {}
  get path(): string {
    return this.parent ? `${this.parent.path} ${this.name}` : 'fy';
  }
}
interface Fn {
  fn: N;
  mod: Module;
  env: Env;
}
type Env = Map<string, unknown>;
const rootCommand = new Cmd('fy');
const visitedCommandCalls = new Set<string>();
const moduleEnvs = new Map<string, Env>();
let callDepth = 0;
function bind(name: N, value: unknown, env: Env) {
  if (name.type === 'Identifier') env.set(name.name, value);
  else if (name.type === 'ObjectPattern')
    for (const element of name.properties as N[]) {
      const key = element.type === 'RestElement' ? propName(element.argument) : keyName(element);
      bind(
        bindingTarget(element.type === 'RestElement' ? element : element.value),
        value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined,
        env,
      );
    }
  else if (name.type === 'ArrayPattern')
    (name.elements as (N | null)[]).forEach((element, index) => {
      if (element) bind(bindingTarget(element), Array.isArray(value) ? value[index] : undefined, env);
    });
}
function moduleEnv(mod: Module): Env {
  let env = moduleEnvs.get(mod.file);
  if (env) return env;
  env = new Map();
  moduleEnvs.set(mod.file, env);
  for (const body of mod.ast.body as N[]) {
    const statement = statementOf(body);
    if (isFunctionDeclaration(statement) && statement.id) env.set(statement.id.name, { fn: statement, mod, env });
  }
  return env;
}
function lookup(name: string, mod: Module, env: Env): unknown {
  if (env.has(name)) return env.get(name);
  if (name === 'BINARY_NAME') return 'fy';
  const global = moduleEnv(mod);
  if (global.has(name)) return global.get(name);
  const decl = mod.declarations.get(name)?.find(candidate => enclosingScope(candidate) === mod.ast);
  if (decl && decl.type === 'VariableDeclarator' && decl.init) {
    global.set(name, undefined);
    const value = evaluate(decl.init, mod, global);
    global.set(name, value);
    return value;
  }
  const imported = mod.imports.get(name);
  const file = imported && importedFile(mod, imported[0]);
  if (file) return lookup(imported![1], parse(file), moduleEnv(parse(file)));
  // Resolve barrel re-exports without loading or running a module.
  for (const statement of mod.ast.body as N[]) {
    let names: N[] | undefined;
    if (statement.type === 'ExportAllDeclaration') names = undefined;
    else if (statement.type === 'ExportNamedDeclaration' && statement.source && !statement.declaration)
      names = statement.specifiers as N[];
    else continue;
    if (!isStringLiteral(statement.source)) continue;
    if (names && !names.some(element => nameOf(element.exported) === name)) continue;
    const target = importedFile(mod, statement.source.value as string);
    if (!target || target === mod.file) continue;
    const targetMod = parse(target);
    if (targetMod.declarations.has(name) || targetMod.source.includes(` ${name}`)) {
      const element = names?.find(candidate => nameOf(candidate.exported) === name);
      const value = lookup(element ? nameOf(element.local) : name, targetMod, moduleEnv(targetMod));
      if (value !== undefined) return value;
    }
  }
  return undefined;
}
function invoke(fn: unknown, values: unknown[]): unknown {
  if (!fn || typeof fn !== 'object' || !('fn' in fn)) return undefined;
  const { fn: node, mod, env } = fn as Fn;
  // Only registration code and pure flag wrappers. Never evaluate an action/controller/helper body.
  if (
    !/\.command\s*\(|\.option\s*\(|\.requiredOption\s*\(|\.addOption\s*\(|register[A-Z]|\bverb\s*\(|writeFlags\s*\(|\.name\(\)\s*===/.test(
      sourceOf(node).text.slice(node.start, node.end),
    )
  )
    return undefined;
  if (++callDepth > 45) throw new Error(`Commander recursion: ${mod.file}:${lineOf(node)}`);
  const local = new Map(env);
  (node.params as N[]).forEach((parameter, index) => {
    const initializer = bindingDefault(parameter);
    bind(
      bindingTarget(parameter),
      values[index] ?? (initializer ? evaluate(initializer, mod, local) : undefined),
      local,
    );
  });
  const result =
    node.body &&
    (node.body.type === 'BlockStatement'
      ? statements(node.body.body, mod, local)
      : { value: evaluate(node.body, mod, local) });
  callDepth--;
  return result?.value;
}
function evaluate(input: N | null | undefined, mod: Module, env: Env): unknown {
  if (!input) return undefined;
  const node = unwrap(input);
  if (node.type === 'Identifier') return lookup(node.name, mod, env);
  if (isStringLike(node)) return stringValue(node);
  if (isNumericLiteral(node)) return node.value;
  if (isTrue(node)) return true;
  if (isFalse(node)) return false;
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression')
    return { fn: node, mod, env } satisfies Fn;
  if (node.type === 'ArrayExpression')
    return (node.elements as (N | null)[]).flatMap(element =>
      element?.type === 'SpreadElement'
        ? ((evaluate(element.argument, mod, env) as unknown[]) ?? [])
        : [evaluate(element, mod, env)],
    );
  if (node.type === 'ObjectExpression') {
    const result: Record<string, unknown> = {};
    for (const property of node.properties as N[]) {
      const kind = propertyKind(property);
      if (kind === 'assign') result[keyName(property)] = evaluate(property.value, mod, env);
      if (kind === 'shorthand') result[property.key.name] = lookup(property.key.name, mod, env);
      if (kind === 'spread') Object.assign(result, evaluate(property.argument, mod, env));
    }
    return result;
  }
  if (isTemplateExpression(node))
    return (
      templateHead(node) +
      templateSpans(node)
        .map(span => `${evaluate(span.expression, mod, env) ?? '{dynamic}'}${span.text}`)
        .join('')
    );
  if (isPropertyAccess(node)) {
    const value = evaluate(node.object, mod, env);
    if (value instanceof Cmd && memberName(node) === 'commands') return value.children;
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[memberName(node)] : undefined;
  }
  if (isElementAccess(node)) {
    const value = evaluate(node.object, mod, env);
    const key = evaluate(node.property, mod, env);
    return value && key !== undefined ? (value as Record<string, unknown>)[String(key)] : undefined;
  }
  // The TypeScript tree reads assignment, logical and comma expressions as binary ones: both sides are evaluated.
  if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression' || node.type === 'AssignmentExpression') {
    const left = evaluate(node.left, mod, env);
    const right = evaluate(node.right, mod, env);
    switch (node.operator) {
      case '===':
        return left === right;
      case '!==':
        return left !== right;
      case '??':
        return left ?? right;
      case '||':
        return left || right;
      case '+':
        return typeof left === 'string' || typeof right === 'string' ? `${left ?? ''}${right ?? ''}` : undefined;
    }
  }
  if (node.type === 'SequenceExpression')
    for (const expression of node.expressions as N[]) evaluate(expression, mod, env);
  if (node.type === 'ConditionalExpression')
    return evaluate(evaluate(node.test, mod, env) ? node.consequent : node.alternate, mod, env);
  if (node.type === 'NewExpression')
    return textOf(node.callee) === 'Command'
      ? new Cmd(String(evaluate(node.arguments[0], mod, env) ?? 'fy'))
      : undefined;
  if (node.type === 'CallExpression') {
    if (isPropertyAccess(node.callee)) {
      const name = memberName(node.callee);
      const receiver = evaluate(node.callee.object, mod, env);
      if (receiver instanceof Cmd) {
        // Arguments to action/hooks may contain arbitrary product code: deliberately do not traverse them.
        if (
          [
            'action',
            'hook',
            'addHelpText',
            'configureHelp',
            'configureOutput',
            'showHelpAfterError',
            'showSuggestionAfterError',
            'allowUnknownOption',
            'enablePositionalOptions',
            'passThroughOptions',
            'helpOption',
          ].includes(name)
        )
          return receiver;
        const values = (node.arguments as N[]).map(argument => evaluate(argument, mod, env));
        if (name === 'command') {
          visitedCommandCalls.add(`${mod.file}:${node.start}`);
          if (typeof values[0] !== 'string') {
            warnings.add(`Commander name unresolved: ${mod.file}:${lineOf(node)} ${textOf(node)}`);
            return undefined;
          }
          const [verb, ...commandArgs] = values[0].split(/\s+/);
          let child = receiver.children.find(candidate => candidate.name === verb);
          if (!child) {
            child = new Cmd(verb!);
            child.parent = receiver;
            receiver.children.push(child);
          }
          child.source ||= `${mod.file}:${lineOf(node)}`;
          child.args.push(...commandArgs);
          return child;
        }
        if (['option', 'requiredOption'].includes(name) && typeof values[0] === 'string') receiver.flags.add(values[0]);
        if (['argument', 'arguments'].includes(name) && typeof values[0] === 'string') receiver.args.push(values[0]);
        if (name === 'description' && typeof values[0] === 'string') receiver.description = values[0];
        if (name === 'alias' && typeof values[0] === 'string') receiver.aliases.push(values[0]);
        if (name === 'aliases' && Array.isArray(values[0])) receiver.aliases.push(...values[0]);
        if (name === 'name' && values.length === 0) return receiver.name;
        if (name === 'version') receiver.flags.add(typeof values[1] === 'string' ? values[1] : '-V, --version');
        return receiver;
      }
      const values = (node.arguments as N[]).map(argument => evaluate(argument, mod, env));
      if (Array.isArray(receiver)) {
        if (name === 'find') return receiver.find(value => invokePredicate(values[0], value));
        if (name === 'forEach') {
          receiver.forEach(value => invoke(values[0], [value]));
          return undefined;
        }
        if (name === 'join') return receiver.join(String(values[0] ?? ','));
        if (name === 'includes') return receiver.includes(values[0]);
      }
      if (receiver && typeof receiver === 'object') return invoke((receiver as Record<string, unknown>)[name], values);
      return undefined;
    }
    return invoke(
      evaluate(node.callee, mod, env),
      (node.arguments as N[]).map(argument => evaluate(argument, mod, env)),
    );
  }
  return undefined;
}
function invokePredicate(value: unknown, argument: unknown): boolean {
  if (!value || typeof value !== 'object' || !('fn' in value)) return false;
  const fn = value as Fn;
  const local = new Map(fn.env);
  const first = (fn.fn.params as N[])[0];
  if (first) bind(bindingTarget(first), argument, local);
  return fn.fn.body ? Boolean(evaluate(fn.fn.body, fn.mod, local)) : false;
}
function statements(nodes: N[], mod: Module, env: Env): { value: unknown } | undefined {
  for (const node of nodes) {
    if (isFunctionDeclaration(node) && node.id) env.set(node.id.name, { fn: node, mod, env });
    else if (node.type === 'VariableDeclaration')
      for (const decl of node.declarations as N[]) bind(decl.id, evaluate(decl.init, mod, env), env);
    else if (node.type === 'ExpressionStatement') evaluate(node.expression, mod, env);
    else if (node.type === 'ReturnStatement') return { value: evaluate(node.argument, mod, env) };
    else if (node.type === 'ForOfStatement') {
      const iterable = evaluate(node.right, mod, env);
      if (Array.isArray(iterable) && node.left.type === 'VariableDeclaration')
        for (const value of iterable) {
          const local = new Map(env);
          bind(node.left.declarations[0].id, value, local);
          if (node.body.type === 'BlockStatement') statements(node.body.body, mod, local);
          else if (node.body.type === 'ExpressionStatement') evaluate(node.body.expression, mod, local);
        }
    } else if (node.type === 'BlockStatement') statements(node.body, mod, env);
    // Guards in registration files are dependency checks, not action handlers. Unknown dependencies
    // cannot hide an existing command from the inventory; register both syntactic arms if necessary.
    else if (node.type === 'IfStatement') {
      for (const arm of [node.consequent, node.alternate] as (N | null)[])
        if (arm) {
          if (arm.type === 'BlockStatement') statements(arm.body, mod, env);
          else if (arm.type === 'ExpressionStatement') evaluate(arm.expression, mod, env);
        }
    }
  }
  return undefined;
}
function commands() {
  const mod = parse('packages/cli/bin/program.ts');
  const env = moduleEnv(mod);
  const wiring = parse('packages/cli/bin/wiring.ts');
  const program = invoke(lookup('createProgram', wiring, moduleEnv(wiring)), []) as Cmd | undefined;
  if (program) {
    rootCommand.flags = program.flags;
  }
  // The actual registrar table is the entry point; injected deps stay inert/undefined.
  invoke(lookup('registerDoctorCommand', mod, env), [rootCommand, {}]);
  const registrars = lookup('DOMAIN_REGISTRARS', mod, env);
  if (!Array.isArray(registrars)) throw new Error('Commander registrar table was not found');
  for (const registrar of registrars) invoke(registrar, [{ program: rootCommand, world: { environment: {} } }]);
  const emit = (command: Cmd, aliasAncestor = '') => {
    const flags = new Set(command.flags);
    let parent = command.parent;
    while (parent) {
      for (const flag of parent.flags) flags.add(flag);
      parent = parent.parent;
    }
    const syntax = `${command.path}${command.args.length ? ` ${[...new Set(command.args)].join(' ')}` : ''}`;
    const [file, line] = command.source.split(/:(?=\d+$)/);
    const aliasOf = aliasAncestor || (/\balias of\b|deprecated:/.test(command.description) ? command.description : '');
    const detail = `${aliasOf ? `alias of ${aliasOf}; ` : ''}${command.description}; flags (including inherited): ${[...flags].sort().join('; ')}`;
    if (file) add('V', syntax, file, Number(line), detail);
    for (const alias of new Set(command.aliases))
      if (file)
        add(
          'V',
          syntax.replace(command.path, `${command.parent?.path ?? 'fy'} ${alias}`),
          file,
          Number(line),
          `alias of ${command.path}; ${detail}`,
        );
    if (command.path === 'fy status' && [...flags].some(flag => flag.includes('--subtree'))) {
      add('V', 'fy status --subtree', file!, Number(line), `variant; ${detail}`, 'packs');
      rows[rows.length - 1]!.name5 = 'fy pack';
    }
    if (command.path === 'fy notify' && [...flags].some(flag => flag.includes('--ping')))
      add('V', 'fy notify --ping', file!, Number(line), `flag variant; ${detail}`, 'agenda');
    for (const child of command.children) emit(child, aliasOf);
  };
  rootCommand.source = 'packages/cli/bin/wiring.ts:80';
  emit(rootCommand);
}

function tools(mod: Module) {
  if (mod.file !== 'packages/cli/src/lib/mcp/tools.ts') return;
  walk(mod.ast, node => {
    if (node.type !== 'ObjectExpression') return;
    const keys = (node.properties as N[]).map(property => (hasName(property) ? keyName(property) : ''));
    if (!keys.includes('name') || !keys.includes('inputSchema') || !keys.includes('description')) return;
    const data = literal(node, mod) as Record<string, unknown>;
    add('T', String(data.name), mod.file, lineOf(node), `wire=${data.tool ?? data.name}; ${data.description}`);
  });
}

/** The name a node gives the code inside it (a function, a method, a property, a variable), or ''. */
function contextOwnName(node: N): string {
  if (isFunctionDeclaration(node)) return node.id ? propName(node.id) : '';
  if (isMethodDeclaration(node) || isPropertyAssignment(node)) return keyName(node);
  if (node.type === 'VariableDeclarator') return propName(node.id);
  return '';
}
function contextName(node: N): string {
  let current = node.parent;
  const parts: string[] = [];
  while (current && current.type !== 'Program') {
    const name = contextOwnName(current);
    if (name && !parts.includes(name)) parts.unshift(name);
    current = current.parent;
  }
  return parts.join('.');
}
function jobs(mod: Module) {
  if (!mod.file.startsWith('packages/daemon/')) return;
  walk(mod.ast, node => {
    if (
      mod.file.includes('/bin/modules/') &&
      isPropertyAssignment(node) &&
      keyName(node) === 'jobs' &&
      node.value.type === 'ObjectExpression'
    ) {
      for (const property of node.value.properties as N[])
        if (hasName(property))
          add(
            'J',
            `module job ${moduleName(mod.file)}.${keyName(property)}`,
            mod.file,
            lineOf(property),
            textOf(property),
          );
    }
    if (node.type !== 'CallExpression') return;
    const callee = textOf(node.callee);
    const timer =
      /(?:^|\.)(?:setInterval|setTimeout|watch|watchFile)$/.test(callee) ||
      /(?:scheduler|timers?|clock)\.(?:after|every|interval|repeat|schedule)$/.test(callee) ||
      /\.deps\.after$/.test(callee);
    const host = mod.file.includes('/bin/');
    const arming =
      host &&
      (/(?:^|\.)(?:arm[A-Z]\w*|start[A-Z]\w*|watch[A-Z]\w*)$/.test(callee) ||
        /\.jobs\.\w+$/.test(callee) ||
        /\.(?:arm|start|watch|run|tick|sweep|schedule|subscribe)$/.test(callee));
    if (!timer && !arming) return;
    if (
      !timer &&
      /(?:serial|sessionMutations|cardStarts|lifecycle|parts\.control|cards|service)\.(?:run|start|startOn)$/.test(
        callee,
      )
    )
      return;
    const context = contextName(node);
    const delayFirst = /(?:scheduler|timers?|clock)\.(?:after|every|interval|repeat|schedule)$/.test(callee);
    const scheduleNode = node.arguments[delayFirst ? 0 : 1];
    const callbackNode = node.arguments[delayFirst ? 1 : 0];
    const schedule = scheduleNode ? textOf(scheduleNode) : '';
    const callback = callbackNode ? textOf(callbackNode) : '';
    const what = `${timer ? 'timer/watcher' : 'job/lifecycle arm'} ${callee} in ${context || 'module'}${schedule ? `; cadence=${schedule.slice(0, 160)}` : ''}${callback ? `; action=${callback.slice(0, 140)}` : ''}`;
    add(
      'J',
      what,
      mod.file,
      lineOf(node),
      `call=${textOf(node).slice(0, 800)}; callback=${callback.slice(0, 350)}; timer sites include one-shot/backoff/adapter schedulers, not just perpetual jobs`,
      ownerOf(mod.file, `${what} ${callback}`),
    );
  });
}

function surfaces(mod: Module) {
  if (!mod.file.startsWith('packages/pwa/src/')) return;
  const file = mod.file;
  if (file.endsWith('.tsx'))
    walk(mod.ast, node => {
      const named =
        (isFunctionDeclaration(node) && node.id) ||
        (node.type === 'VariableDeclarator' && node.id.type === 'Identifier')
          ? (node.id as N).name
          : '';
      if (
        named &&
        /^[A-Z]/.test(named) &&
        /(?:Page|Panel|Screen|Sheet|Dialog|View|Settings|Surface|Tabs|Menu|Drawer|Modal|Tab|Section|Route)$/.test(named)
      )
        add(
          'S',
          `component ${named}`,
          file,
          lineOf(node),
          `UI declaration; ${file.includes('/settings/') ? 'settings surface' : 'feature/shell surface'}`,
        );
    });
  if (file.endsWith('/lib/pages/routes.ts'))
    walk(mod.ast, node => {
      if (
        node.type === 'VariableDeclarator' &&
        node.id.type === 'Identifier' &&
        /Path$/.test(node.id.name) &&
        node.init
      ) {
        add('S', `route ${node.id.name}: ${routeTemplate(node.init, mod)}`, file, lineOf(node), textOf(node.init));
      }
      if (node.type === 'TSInterfaceDeclaration') {
        const kind = (node.body.body as N[]).find(
          member =>
            (member.type === 'TSPropertySignature' || member.type === 'TSMethodSignature') &&
            propName(member.key, member.computed) === 'kind',
        );
        if (kind && kind.type === 'TSPropertySignature' && kind.typeAnnotation)
          add(
            'S',
            `screen ${textOf(kind.typeAnnotation.typeAnnotation)}`,
            file,
            lineOf(node),
            `route model ${node.id.name}`,
          );
      }
    });
  if (
    /settings|navigation|nav-model|side-pane-tab|view-tabs|palette-destinations|App\.tsx|page-host|machine-route|machine-panels|app-bar/.test(
      file,
    )
  )
    walk(mod.ast, node => {
      if (node.type === 'ObjectExpression') {
        const keys = (node.properties as N[]).map(property => (hasName(property) ? keyName(property) : ''));
        if (!keys.includes('id') && !keys.includes('key')) return;
        if (!keys.some(key => ['label', 'title', 'settingIds', 'render', 'Component'].includes(key))) return;
        const data = literal(node, mod) as Record<string, unknown>;
        const identity = (node.properties as N[]).find(
          property => isPropertyAssignment(property) && ['id', 'key'].includes(keyName(property)),
        );
        if (!identity || !isPropertyAssignment(identity) || typeof literal(identity.value, mod) !== 'string') return;
        add(
          'S',
          `settings/navigation ${String(data.id ?? data.key)}: ${String(data.label ?? data.title ?? '')}`,
          file,
          lineOf(node),
          `catalog entry in ${contextName(node)}`,
        );
        if (Array.isArray(data.panels))
          for (const panel of data.panels)
            if (typeof panel === 'string')
              add(
                'S',
                `settings panel ${panel}`,
                file,
                lineOf(node),
                `group=${data.id}; tab=${data.tab}; label=${data.label}`,
              );
      }
      if (
        node.type === 'TSTypeAliasDeclaration' &&
        /(?:Tab|Pane|Panel|Section)(?:Id|Key|Name)?$/.test(node.id.name) &&
        node.typeAnnotation.type === 'TSUnionType'
      ) {
        for (const type of node.typeAnnotation.types as N[])
          if (type.type === 'TSLiteralType')
            add('S', `${node.id.name} ${textOf(type)}`, file, lineOf(type), 'tab/panel/section discriminant');
      }
      if (node.type === 'VariableDeclarator' && /(?:SLOTS|TABS|DESTINATIONS)$/.test(bindingText(node.id))) {
        const value = node.init && unwrap(node.init);
        if (value && value.type === 'ObjectExpression')
          for (const property of value.properties as N[])
            if (hasName(property))
              add('S', `${bindingText(node.id)} ${keyName(property)}`, file, lineOf(property), textOf(property));
      }
    });
}

/** Expand the app's path builders symbolically; never call the production router. */
function routeTemplate(input: N, mod: Module, seen = new Set<N>()): string {
  const node = unwrap(input);
  if (seen.has(node)) return ':dynamic';
  seen = new Set(seen).add(node);
  if (isStringLike(node)) return stringValue(node);
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    if (node.body.type !== 'BlockStatement') return routeTemplate(node.body, mod, seen);
    const returns = (node.body.body as N[]).filter(statement => statement.type === 'ReturnStatement');
    const last = returns.at(-1);
    return last?.argument ? routeTemplate(last.argument, mod, seen) : ':dynamic';
  }
  if (isTemplateExpression(node))
    return (
      templateHead(node) +
      templateSpans(node)
        .map(span => `${routeTemplate(span.expression, mod, seen)}${span.text}`)
        .join('')
    );
  if (node.type === 'Identifier') {
    const decl = declaration(mod, node.name, node);
    if (decl && decl.type === 'VariableDeclarator' && decl.init) return routeTemplate(decl.init, mod, seen);
    return node.name === 'id' ? ':daemonId' : `:${node.name}`;
  }
  if (isPropertyAccess(node)) return `:${memberName(node)}`;
  if (node.type === 'CallExpression') {
    if (textOf(node.callee) === 'encodeURIComponent') return routeTemplate(node.arguments[0], mod, seen);
    const name = textOf(node.callee);
    const decl = mod.declarations.get(name)?.[0];
    if (decl && decl.type === 'VariableDeclarator' && decl.init) return routeTemplate(decl.init, mod, seen);
    return `:${isPropertyAccess(node.callee) ? textOf(node.callee.object) : 'dynamic'}`;
  }
  if (node.type === 'ConditionalExpression')
    return `{${routeTemplate(node.consequent, mod, seen)}|${routeTemplate(node.alternate, mod, seen)}}`;
  return ':dynamic';
}

function configPaths(mod: Module) {
  if (mod.file !== 'packages/protocol/src/lib/config-files.ts') return;
  const value = (name: string) => {
    const decl = mod.declarations.get(name)?.[0];
    return decl && decl.type === 'VariableDeclarator' ? literal(decl.init, mod) : undefined;
  };
  const singletons = value('SINGLETON_FILES') as Record<string, string> | undefined;
  const named = value('NAMED_DIRECTORIES') as Record<string, string> | undefined;
  const kinds = value('CONFIG_COMPONENT_KINDS') as string[] | undefined;
  const configOwners: Record<string, string> = {
    machine: 'runtimes',
    login: 'logins',
    profile: 'runtimes',
    runtime: 'runtimes',
    preset: 'logins',
    models: 'logins',
    warden: 'warden',
    learning: 'lessons',
    voice: 'voice',
    pack: 'packs',
    limits: 'ferrets',
    modelsGuide: 'packs',
    accountDefaults: 'accounts',
    instructions: 'ferrets',
    mcp: 'mcp',
    skills: 'skills',
    settings: 'claude-code',
    hooks: 'claude-code',
    modelSets: 'runtimes',
  };
  const sourceLine = (name: string) => lineOf(mod.declarations.get(name)![0]!);
  if (singletons)
    for (const [kind, file] of Object.entries(singletons))
      add(
        'F',
        `FY_HOME/config/${file}`,
        mod.file,
        sourceLine('SINGLETON_FILES'),
        `config singleton; kind=${kind}; generated from SINGLETON_FILES`,
        configOwners[kind],
      );
  if (named)
    for (const [kind, directory] of Object.entries(named))
      add(
        'F',
        `FY_HOME/config/${directory}/{name}.yaml`,
        mod.file,
        sourceLine('NAMED_DIRECTORIES'),
        `named config family; kind=${kind}`,
        configOwners[kind],
      );
  if (kinds)
    for (const kind of kinds) {
      add(
        'F',
        `FY_HOME/config/components/${kind}/{name}.yaml`,
        mod.file,
        sourceLine('CONFIG_COMPONENT_KINDS'),
        `component config family; kind=${kind}`,
        configOwners[kind],
      );
      if (kind === 'settings')
        add(
          'F',
          `FY_HOME/config/components/${kind}/{name}.yaml (Codex scope)`,
          mod.file,
          sourceLine('CONFIG_COMPONENT_KINDS'),
          'same current item family; harness-specific scope moves to the Codex package (§8)',
          'codex',
        );
    }
  const schemas = value('CONFIG_SCHEMA_IDS');
  if (Array.isArray(schemas))
    for (const id of schemas)
      if (typeof id === 'string')
        add(
          'F',
          `FY_HOME/config/.schema/${id}.json`,
          mod.file,
          sourceLine('CONFIG_SCHEMA_IDS'),
          'generated editor JSON schema',
          'kernel',
        );
  if (kinds)
    for (const kind of kinds)
      add(
        'F',
        `FY_HOME/config/.schema/component-${kind}.json`,
        mod.file,
        sourceLine('CONFIG_SCHEMA_IDS'),
        'component schema from CONFIG_SCHEMA_IDS mapped spread',
        'kernel',
      );
}

const foundation: Record<string, string> = {};
const sessionPaths: Record<string, string> = {};
const constructorRoots = new Map<string, Map<number, Set<string>>>();
const localPathMaps = new Map<string, Record<string, string>>();
const knownRoots: Record<string, string> = {
  stateHome: 'FY_HOME',
  fyHome: 'FY_HOME',
  state: 'FY_HOME/state',
  stateDirectory: 'FY_HOME/state',
  fleet: 'FY_HOME/fleet',
  fleetDirectory: 'FY_HOME/fleet',
  configDirectory: 'FY_HOME/config',
  configRoot: 'FY_HOME/config',
  wardenRoot: 'FY_HOME/state/warden',
};
/** Preserve dynamic segments; this is a path declaration inventory, not a filesystem scan. */
function pathValue(input: N | null | undefined, mod: Module, seen = new Set<N>()): string {
  if (!input) return '{unknown}';
  const node = unwrap(input);
  if (seen.has(node)) return `{${textOf(node)}}`;
  seen = new Set(seen).add(node);
  if (isStringLike(node)) return stringValue(node);
  if (isTemplateExpression(node))
    return (
      templateHead(node) +
      templateSpans(node)
        .map(span => `${pathValue(span.expression, mod, seen)}${span.text}`)
        .join('')
    );
  if (node.type === 'Identifier') {
    const value = literal(node, mod);
    if (typeof value === 'string') return value;
    if (node.name === 'home' && mod.file === 'packages/daemon/src/lib/paths.ts') return 'FY_HOME';
    const root = constructorRoot(node, mod, node.name);
    if (root) return root;
    const decl = declaration(mod, node.name, node);
    if (decl && decl.type === 'VariableDeclarator' && decl.init) return pathValue(decl.init, mod, seen);
    if (knownRoots[node.name]) return knownRoots[node.name]!;
    return `{${node.name}}`;
  }
  if (isPropertyAccess(node)) {
    const expression = textOf(node.object);
    if (
      /^(?:this\.)?paths$/.test(expression) &&
      localPathMaps.has(mod.file) &&
      !/create\w*Paths/.test(contextName(node))
    ) {
      const local = localPathMaps.get(mod.file)![memberName(node)];
      if (local) return local;
    }
    if (expression === 'this') {
      const root = constructorRoot(node, mod, memberName(node));
      if (root) return root;
      // Class path fields initialized from a constructor's confined root.
      let enclosing: N | undefined = node;
      while (enclosing && enclosing.type !== 'ClassDeclaration') enclosing = enclosing.parent;
      if (enclosing) {
        let result: string | undefined;
        walk(enclosing, candidate => {
          if (
            candidate.type === 'AssignmentExpression' &&
            candidate.operator === '=' &&
            textOf(candidate.left) === textOf(node)
          )
            result = pathValue(candidate.right, mod, seen);
        });
        if (result) return result;
      }
    }
    if (/createSessionPaths\(/.test(expression) || expression === 'sessionPaths')
      return sessionPaths[memberName(node)] ?? `{${textOf(node)}}`;
    if (
      /(?:^|\.)(?:paths|foundation|layout)$/.test(expression) ||
      expression === 'this.paths' ||
      expression.endsWith('.paths')
    ) {
      if (foundation[memberName(node)]) return foundation[memberName(node)]!;
      if (knownRoots[memberName(node)]) return knownRoots[memberName(node)]!;
    }
    if (/stateHome(?:\.path)?$/.test(textOf(node))) return 'FY_HOME';
    return `{${textOf(node)}}`;
  }
  if (node.type === 'CallExpression') {
    if (/(?:^|\.)(?:join|resolve|joinPath)$/.test(textOf(node.callee)))
      return (node.arguments as N[])
        .map(argument => pathValue(argument, mod, seen))
        .join('/')
        .replace(/\/{2,}/g, '/');
    if (isPropertyAccess(node.callee) && textOf(node.callee.object) === 'this') {
      const root = constructorRoot(node, mod, memberName(node.callee));
      if (root) return root;
    }
  }
  if (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement')
    return pathValue(node.body, mod, seen);
  return `{${textOf(node).slice(0, 160)}}`;
}
function constructorRoot(node: N, _mod: Module, name: string): string | undefined {
  let enclosing: N | undefined = node;
  while (enclosing && enclosing.type !== 'ClassDeclaration') enclosing = enclosing.parent;
  if (!enclosing || !enclosing.id) return;
  const ctor = (enclosing.body.body as N[]).find(
    member => member.type === 'MethodDefinition' && member.kind === 'constructor',
  );
  if (!ctor) return;
  const index = (ctor.value.params as N[]).findIndex(parameter => propName(bindingTarget(parameter)) === name);
  if (index < 0) return;
  const roots = constructorRoots.get(enclosing.id.name)?.get(index);
  return roots?.size === 1 ? [...roots][0] : undefined;
}
function storage(mod: Module) {
  if (!/^packages\/(?:daemon|fleet|cli|protocol)\//.test(mod.file)) return;
  walk(mod.ast, node => {
    const joinCall = node.type === 'CallExpression' && /(?:^|\.)(?:join|resolve|joinPath)$/.test(textOf(node.callee));
    const template = isTemplateExpression(node);
    const pathConstant =
      node.type === 'VariableDeclarator' &&
      /(?:PATH|FILE|FILENAME|DOCUMENT|BACKUP|MARKER|OUTBOX|PENDING|NAME)$/.test(bindingText(node.id)) &&
      node.init;
    const filename =
      isStringLiteral(node) &&
      /^[\w.-]+\.(?:jsonl?|ya?ml|sqlite|db|log|sock|key|txt|toml)$/.test(node.value as string) &&
      /\/adapters\/|\/lib\/(?:agenda|scratch|pack|account|usage|shared-history|config-files)/.test(mod.file) &&
      !/\/host-harness-scan|syscall-tracer|browser\/|imports\//.test(mod.file);
    if (!joinCall && !template && !pathConstant && !filename) return;
    const expression: N = pathConstant ? node.init : node;
    if (
      pathConstant &&
      !isStringLike(unwrap(expression)) &&
      !isTemplateExpression(unwrap(expression)) &&
      unwrap(expression).type !== 'CallExpression'
    )
      return;
    const value = pathValue(expression, mod);
    const raw = textOf(expression);
    // Include durable documents, caches, sockets, logs and directory families. Exclude URLs,
    // package/test assets and paths explicitly outside Ferretry's home.
    if (/https?:|node_modules|\.git\b|\/etc\/|\/run\/|\.github|\.(?:png|svg|css|js|tsx?)$/.test(value)) return;
    if (
      !(joinCall && definiteHome(value)) &&
      !/(?:\.(?:jsonl?|ya?ml|sqlite(?:-wal|-shm)?|db|log|lock|sock|key|md|toml|txt)|(?:^|\/)(?:api-token|warden-token|layout-version|session-version|manifest|credentials|config|homes|assets|blobs|reports|sessions|attachments|turns|input-requests|payloads|runs|skills|instructions|browser-upload|forks|moves)(?:\/|$))/.test(
        value,
      )
    )
      return;
    if (
      /(?:userHome|process\.cwd|import\.meta|projectRoot|repoRoot|worktreeRoot)|mkdtemp|fy-format-probe|fy-trace-|runtimeDirectory|\/tmp/.test(
        value,
      )
    )
      return;
    if (!definiteHome(value) && /(?:\.claude|\.codex)/.test(value)) return;
    const definite = value.includes('FY_HOME');
    const storageContext =
      /\/adapters\/|paths|layout|store|storage|files|config|ledger|journal|repository|state-home|manifest|registry|runtime|modules|fyd\.ts/.test(
        mod.file,
      );
    if (!definite && !storageContext) return;
    if (!definite && !joinCall && !pathConstant && !filename) return;
    let shape = value;
    for (let pass = 0; pass < 8; pass++) shape = shape.replace(/\{[^{}]*\}/g, ':segment');
    if (/\s/.test(shape) || (shape.startsWith(':segment') && !shape.includes('/'))) return;
    if (
      value.length > 500 ||
      value.includes('\n') ||
      (!value.startsWith('FY_HOME/') &&
        !value.startsWith('{') &&
        !/^[\w.-]+\.(?:jsonl?|ya?ml|sqlite|log|lock|sock|key|md|toml|txt)$/.test(value) &&
        !/^(?:api-token|warden-token|layout-version|session-version)$/.test(value))
    )
      return;
    const context = contextName(node);
    add(
      'F',
      value,
      mod.file,
      lineOf(node),
      `owner module=${moduleName(mod.file)}; ${definite ? 'FY_HOME anchored' : 'relative/path family: root supplied by composition; verify confinement when porting'}; ${context}; expression=${raw.slice(0, 500)}`,
    );
  });
}
const definiteHome = (value: string) => value.includes('FY_HOME');

// Resolve the canonical foundation first so later adapters retain the actual FY_HOME-relative path.
const pathsModule = parse('packages/daemon/src/lib/paths.ts');
walk(pathsModule.ast, node => {
  if ((isPropertyAssignment(node) || isShorthandAssignment(node)) && /createFoundationPaths/.test(contextName(node))) {
    const name = keyName(node);
    const expression: N = node.value;
    if (expression.type === 'Identifier' || expression.type === 'CallExpression') {
      const value = pathValue(expression, pathsModule);
      if (value.includes('FY_HOME')) foundation[name] = value;
    }
  }
});
walk(pathsModule.ast, node => {
  if (isPropertyAssignment(node) && /createSessionPaths/.test(contextName(node))) {
    sessionPaths[keyName(node)] = pathValue(node.value, pathsModule);
  }
});
sessionPaths.directory = 'FY_HOME/state/sessions/{sessionId}';
foundation.binDirectory = 'FY_HOME/fleet/bin';
foundation.homesDirectory = 'FY_HOME/fleet/homes';
foundation.assetsDirectory = 'FY_HOME/fleet/assets';
// Link constructor root parameters back to their composition sites without executing either side.
for (const file of files.filter(file => /^packages\/(?:daemon|cli|fleet)\//.test(file))) {
  const content = readFileSync(join(sourceRoot, file), 'utf8');
  if (!/new \w+\(/.test(content) || !/paths\.|stateHome|stateDirectory/.test(content)) continue;
  const mod = parse(file);
  walk(mod.ast, node => {
    if (node.type !== 'NewExpression') return;
    const name = textOf(node.callee);
    (node.arguments as N[]).forEach((argument, index) => {
      const value = pathValue(argument, mod);
      if (!value.startsWith('FY_HOME') || (value.includes('{') && !/sessions\/\{/.test(value))) return;
      const roots = constructorRoots.get(name) ?? new Map<number, Set<string>>();
      const candidates = roots.get(index) ?? new Set<string>();
      candidates.add(value);
      roots.set(index, candidates);
      constructorRoots.set(name, roots);
    });
  });
  if (!file.startsWith('packages/cli/')) modules.delete(file);
}
commands();
for (const file of files) {
  const content = readFileSync(join(sourceRoot, file), 'utf8');
  digest.update(file).update('\0').update(content).update('\0');
  const mod = parse(file);
  if (file.startsWith('packages/cli/'))
    walk(mod.ast, node => {
      if (
        node.type === 'CallExpression' &&
        isPropertyAccess(node.callee) &&
        memberName(node.callee) === 'command' &&
        !visitedCommandCalls.has(`${file}:${node.start}`)
      )
        warnings.add(
          `Commander declaration not reached from DOMAIN_REGISTRARS: ${file}:${lineOf(node)} ${textOf(node).slice(0, 200)}`,
        );
    });
  // Private path factories (LearningPaths, WardenPaths, etc.) may reuse FoundationPaths field names.
  // Their roots must never overwrite the foundation or a ferret's paths.
  const local: Record<string, string> = {};
  walk(mod.ast, node => {
    if (
      (isPropertyAssignment(node) || isShorthandAssignment(node)) &&
      /create\w+Paths/.test(contextName(node)) &&
      !/createFoundationPaths|createSessionPaths/.test(contextName(node))
    )
      local[keyName(node)] = pathValue(node.value, mod);
  });
  if (Object.keys(local).length) localPathMaps.set(file, local);
  if (file.startsWith('packages/daemon/')) routes(mod);
  tools(mod);
  jobs(mod);
  surfaces(mod);
  storage(mod);
  configPaths(mod);
  // Release non-CLI trees after each file; shared box, no compiler program/typechecker required.
  if (!file.startsWith('packages/cli/') && !file.startsWith('packages/protocol/')) modules.delete(file);
}
/**
 * The daemon's own command line: every long option its argument parser knows (`--check`, `--port`, ...), as a kernel
 * `V` row named `fyd <option>`. Read from the parser's string literals, so an option added there appears here.
 */
const FYD_OPTION_TESTS: Record<string, string> = {
  '--check': 'fyd-check.test.ts',
  '--print-config': 'fyd-print-config.test.ts',
  '--config': 'fyd-overrides.test.ts',
  '--host': 'fyd-overrides.test.ts',
  '--log-level': 'fyd-overrides.test.ts',
};
function daemonOptions() {
  const file = 'packages/daemon/src/lib/runtime/arguments.ts';
  if (!files.includes(file)) return;
  const mod = parse(file);
  const seen = new Set<string>();
  walk(mod.ast, node => {
    const value = node.type === 'Literal' ? node.value : undefined;
    if (typeof value !== 'string' || !/^--[a-z][a-z-]*$/.test(value) || seen.has(value)) return;
    seen.add(value);
    add('V', `fyd ${value}`, file, lineOf(node), 'daemon option; honoured by the daemon entry', 'kernel');
    rows[rows.length - 1]!.check =
      `packages/core/kernel/tests/unit/host/${FYD_OPTION_TESTS[value] ?? 'fyd-arguments.test.ts'}`;
  });
}
daemonOptions();
// Every feature boundary is explicit even where a component is named without a Panel/Page suffix.
const features = new Set(
  files
    .filter(file => file.startsWith('packages/pwa/src/features/'))
    .map(file => file.split('/').slice(0, 5).join('/')),
);
for (const feature of [...features].sort()) {
  const source =
    files.find(file => file.startsWith(`${feature}/`) && file.endsWith('.tsx')) ??
    files.find(file => file.startsWith(`${feature}/`))!;
  add(
    'S',
    `feature ${feature.split('/').at(-1)}`,
    source,
    1,
    `feature folder ${feature}; individual named surfaces are listed separately`,
  );
}

// SQLite's durable sidecars are written by the engine rather than by an explicit writeFile call.
for (const row of [...rows].filter(row => row.kind === 'F' && /\.sqlite$/.test(row.what))) {
  const [file, line] = row.source.split(/:(?=\d+$)/);
  for (const suffix of ['-wal', '-shm'])
    add(
      'F',
      `${row.what}${suffix}`,
      file!,
      Number(line),
      `SQLite engine sidecar; declared database=${row.what}; see sqliteDatabaseFiles in packages/daemon/src/lib/paths.ts`,
      row.owner,
    );
}

const columns: (keyof Row)[] = [
  'id',
  'kind',
  'what',
  'source',
  'todayOwner',
  'owner',
  'name5',
  'descriptor',
  'check',
  'status',
];
const previous = new Map<string, Row>();
const next: Record<Kind, number> = { R: 1, V: 1, T: 1, S: 1, J: 1, F: 1 };
if (existsSync(tsvPath)) {
  const [header, ...lines] = readFileSync(tsvPath, 'utf8').trimEnd().split('\n');
  if (header !== columns.join('\t')) throw new Error('Unexpected TSV schema; preserve the ID/status registry');
  for (const line of lines) {
    const values = line.split('\t');
    const row = Object.fromEntries(columns.map((key, index) => [key, values[index] ?? ''])) as unknown as Row;
    previous.set(rowKey(row), row);
    next[row.kind] = Math.max(next[row.kind], Number(row.id.slice(2)) + 1);
  }
}
const unique = new Map<string, Row>();
for (const row of rows.sort((a, b) => rowKey(a).localeCompare(rowKey(b)))) {
  const key = rowKey(row);
  const existing = unique.get(key);
  if (existing) {
    if (existing.descriptor !== row.descriptor) existing.descriptor += `; other declaration: ${row.descriptor}`;
    continue;
  }
  const old = previous.get(key);
  row.id = old?.id ?? `${row.kind}-${String(next[row.kind]++).padStart(4, '0')}`;
  if (old && !row.status.startsWith('removed by design') && !old.status.startsWith('removed by design'))
    row.status = old.status;
  // A route ticked `[x]` names the route test that proves it (parity-ticks); the generator's default is only the check
  // a port must add, so a test path someone wrote survives regeneration. Only a TICKED row keeps it: a row reverted to
  // `[ ]` goes back to the default, so an open row never points at a test that no longer proves it.
  if (old && row.kind === 'R' && old.status.startsWith('[x]') && old.check !== 'descriptor-parity')
    row.check = old.check;
  unique.set(key, row);
}
/**
 * Moves the rows `REOWNED` names to their 5.0 owner (and that owner's check file). The ids belong to the committed
 * registry in docs/design, so an id it lacks is an error there; a run into another `--out-dir` (the generator's own
 * fixture) has no such registry and skips ids it does not hold.
 */
function applyReowned(all: ReadonlyMap<string, Row>) {
  const byId = new Map([...all.values()].map(row => [row.id, row]));
  for (const [id, owner] of Object.entries(REOWNED)) {
    const row = byId.get(id);
    if (!row) {
      if (outputDirectory !== resolve(join(root, 'docs/design'))) continue;
      throw new Error(`REOWNED names ${id}, which is not in the inventory`);
    }
    row.owner = owner;
    // A ticked route row already names the test that proves it (kept from the registry above); moving the row to its
    // real owner must not put the default check back, or the owner's tick loses its test path on the next regeneration.
    const provenRoute = row.kind === 'R' && row.status.startsWith('[x]') && row.check !== 'descriptor-parity';
    if (!provenRoute) row.check = checkOf(row.kind, row.what, stripLine(row.source), owner);
  }
}
applyReowned(unique);
const inventory = [...unique.values()].sort(
  (a, b) =>
    owners.indexOf(a.owner) - owners.indexOf(b.owner) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
);
const clean = (value: string) => value.replace(/[\t\r\n]+/g, ' ');
const tsv = `${columns.join('\t')}\n${inventory.map(row => columns.map(key => clean(row[key])).join('\t')).join('\n')}\n`;
const escaped = (value: string) => clean(value).replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const count = (kind: Kind, owner?: string) =>
  inventory.filter(row => row.kind === kind && (!owner || row.owner === owner)).length;
const removed = inventory.filter(row => row.status.startsWith('removed by design')).length;
const unplaced = inventory.filter(row => row.owner === 'UNPLACED');
const out: string[] = [
  '# Ferretry 5.0 rebuild parity',
  '',
  'Generated by `scripts/rebuild/parity.ts`. Do not add inventory rows by hand. Update status in the TSV, then regenerate; IDs and status survive regeneration.',
  '',
  `Reference commit: \`${sourceHead}\`. Tracked product-source SHA-256: \`${digest.digest('hex')}\`.`,
  '',
  'Reproduce: `bun scripts/rebuild/parity.ts --source ../rebuild-ref`. Validate without writing: append `--check`. The syntax parser is `oxc-parser`, already a dev dependency; nothing else needs installing.',
  '',
  'Generator regression checks: `bun test scripts/rebuild/parity.test.ts` (first observe the team’s single-test-process limit). The fixture uses a temporary source repository and an untouched temporary FY_HOME; it proves that production imports and command actions never run.',
  '',
  'Generator typecheck: it is part of the repository typecheck (`scripts/tsconfig.json`, run by `scripts/validate/typecheck.sh`), with strict indexed-access checks.',
  '',
  `**${inventory.length} rows; ${removed} removed by design; ${unplaced.length} unplaced owners.**`,
  '',
  '<!-- prettier-ignore -->',
  '| Kind | Count |',
  '| --- | ---: |',
  ...Object.entries(kindNames).map(([kind, name]) => `| ${kind}: ${name} | ${count(kind as Kind)} |`),
  '',
  '<!-- prettier-ignore -->',
  '| 5.0 owner | R | V | T | S | J | F | Total |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...owners.map(
    owner =>
      `| ${owner} | ${(['R', 'V', 'T', 'S', 'J', 'F'] as Kind[]).map(kind => count(kind, owner)).join(' | ')} | ${inventory.filter(row => row.owner === owner).length} |`,
  ),
  '',
  '## Reading the inventory',
  '',
  '- Ownership follows redesign §8 and the split responsibilities in §2.3. The 5.0 name follows §1.4; item commands fan out per item kind.',
  '- A check names the test the port must add; it is a requirement, not a claim that a test already exists. Every kept row begins unchecked.',
  '- Route descriptors come from syntax, resolving constant objects and spreads. An absent boolean is false; absent capability/remedy is none; missing required fields are shown explicitly. Member routes retain their separate `needs` descriptor.',
  '- Jobs count source sites, including adapter schedulers, one-shot/backoff timers and lifecycle arming calls. Multiple sites can participate in one runtime job.',
  '- Files are source declarations and parameterized path families, never a scan of a real home. Relative families retain their symbolic root and confinement-review note. Several modules may declare the same file.',
  '- Removed rows cite a section that explicitly deletes the old behavior/file. A rename or moved feature remains required. No converter is authorized by this list (§9.1).',
  '- R-0150 (the session file diff) and R-0151 (the session file read) are a deliberate 5.0 hardening, not a parity break: the text a caller receives now has every vault value found whole in the text (the diff, hunk-header section heading included and joined to the hunks around it; a heading git cut to 80 bytes, or stripped of its trailing spaces and tabs, is a partial, the file, or the bytes of a non-UTF-8 file) masked; a value shown only in part, a non-ASCII value in bytes that are not UTF-8, or a value inside compressed bytes, is not, on top of the unchanged secrets-policy gates; an agent loses a read it had today (a file, or a diff of a file whose HEAD or working side holds a vault value, is refused with `holds_secret`), and a person is told the bytes are masked (`redacted: true`).',
  '- T-0032 (config_read), T-0033 (config_validate) and T-0034 (config_write) are tightened by design, not a parity break: a raw key in a YAML comment or a tag is now a raw secret like one in a value. Today the detector walked parsed values only, so such a file was accepted, its text returned by `config_read` and a write of it by an agent put in effect; in 5.0 the same check (every reload, every write, the agent door) scans the raw text line by line too, so the file is refused with a located issue that never repeats the key, its last good version stays in effect, `config_read` withholds its text, and `config_validate` / `config_write` refuse it.',
  '- F-0324 (a ferret\u2019s `environment.json`) with the launch read allowance is tightened by design, not a parity break: today every Claude launch pre-allowed reads of the hand-off folders (`handoffFolders`, `fyd.ts:10841`; no inventory row of its own, its paths are joins over a passed folder) and never of the session folder, so `environment.json` was never readable without asking and still is not. 5.0 pre-allows the ferret\u2019s OWN `turns/`, `channel/` and `attachments/` (`LaunchSpec.readable`, Codex adds nothing, as today) and drops today\u2019s fourth, the attachment root a send\u2019s delivered copies were written to, because 5.0 writes no delivered copy to disk yet (GAP(deliver)). Pinned by `packages/plugins/claude-code/tests/unit/parity/launch-read-allow.test.ts` against today\u2019s argv.',
  '- T-0032 (config_read), T-0033 (config_validate) and T-0034 (config_write), with boot and every reload, are also tightened by design on SIZE and SHAPE, not a parity break: today’s 256 KiB cap held at the wire and at the disk read only; in 5.0 the same cap is checked inside the one check every door uses, before anything parses or scans the text (boot, reload, an accepted record read back, a file that grew after its size was read, config_read, config_validate, config_write), so a text over it is refused in one fixed sentence that quotes nothing, config_read shows no text of it, its last good version stays in effect and boot carries on. Two shapes today read on are refused too, located: a mapping key that is a mapping or a list (or an alias to one), and aliases whose read-out value weighs more than 10 000 plus 2 per character of the file, a string weighing its length (today the library counted aliases, not what they read out to).',
  '- AGENDA-SEND-NOW-COMPOSER (agenda "Send now" into the owner\'s composer) is tightened by design, not a parity break: today `AgendaReplyBatcher.sendNow` skipped the composer check, so a Send now typed into a draft the owner was writing and merged with it, though its doc said it never types into a non-empty composer. 5.0 types nothing into a non-empty or unreadable composer: the answers stay queued in order and are rechecked, and a Send now into an empty composer types once, with the held answers. Pinned by `packages/core/asks/tests/unit/daemon/agenda/reply-batch.test.ts` ("should never type on \\"Send now\\" into a composer that holds text, and keep the answers queued in order", with its siblings for an unreadable composer and for a composer that empties).',
  "- R-0349 (the owner's input-request deliver) is tightened by design for a page card, not a parity break (#42 SF1): \"What agents may control › Browsers\" is read at the page target, the one gate every write into a ferret's page passes, so the owner's Send on a page card raised while Browsers was on is refused once it is off (today it typed whatever the switch said). Nothing is typed or held, the card goes back to pending and can be sent again once Browsers is on, and the owner is told \"Agents may no longer control browsers on this machine, so this card was not typed into the page. Turn on Browsers under What agents may control and try again, or dismiss the card.\" The agents' sentence (T-0024 browser_request_input, T-0042 secure_paste) is today's, unchanged. A terminal card's Send still types while Terminals is off, as today.",
  "- Renaming a runtime is changed by design, not a parity break (ruling #52, kernel batch item 4, user-visible): today the rename rewrote every mention of the runtime in `warden.yaml` and `learning.yaml` in the same act (`renamedRuntimeMentions`, `rebuild-ref/packages/fleet/src/lib/config-files/render.ts`). In 5.0 no plugin writes another plugin's file, so Runtimes publishes `runtimes.renamed { from, to }` and Warden and Lessons each re-point their own file through `writeAsOwner` a moment later. Until a file is re-pointed (or while a re-point is held for the owner) that plugin's status says its file names a runtime that no longer exists. Pinned by a Warden and a Lessons test of the re-point when that wiring lands (GAP in ports-pending `runtimes`).",
  '- A locked machine\'s Inbox row is worded differently, not a parity break (ruling #55, shell contract S2): the passkey lock is v4\'s own rule and asks at the same moments (background reads of a machine not on screen wait, anything pressed asks at once). In 5.0 the Inbox row of a locked machine says "Locked — unlock <machine> to see its items" with an Unlock button, where v4 showed the machine as locked in the Machines list only.',
  '- R-0295 (applying an account-model change) is changed by design, not a parity break (#52 Q3, the cross-plugin set deferred): today\u2019s apply wrote every document a change touched as ONE set inside the provisioner\u2019s rollback, across what are now Runtimes\u2019 files (`runtimes.yaml`, `runtimes/`, `profiles/`, `model-sets/`), Logins\u2019 (`logins/<id>.yaml`) and the harness plugins\u2019 (`claude-code/settings`, `codex/settings`). In 5.0 a set is all-or-none per OWNER: Runtimes writes its own documents through `ConfigPort.writeAll` (one held document holds the set; an intent record is rolled back on load), and every other owner writes its own file when it hears `runtimes.applied`. A crash between owners can therefore leave a login naming a runtime that is not there yet; the next boot says so in a sentence ("names a runtime this machine does not have"), never fixes it silently. One set across owners would be Gate\u2019s (every owner\u2019s judge and a set-level held record) and is deferred past 5.0.',
  "- AK-B1…AK-B13 (Board) and AK-A1…AK-A10 (Agenda) are the session archive's keep signals, today's `board: boardWorld.board.snapshot()` and `hasOpenAgendaItem` (`fyd.ts:11777-11779`; no inventory row of their own, J-0185 is the pass that reads them): archive default off today; takers answer for when it is on. Both take Ferrets' `session.archive-keeps` hook, so neither plugin reaches the other. Board answers every card (owner, assignee, dropped, lane category); Ferrets keeps today's rule over it (not dropped, lane not `closed` or `shipped`, unknown lane in flight). Agenda answers whether the ferret's own board holds an active item. A source that fails, an answer that is not the ferret's own board, and an agenda board with entries that did not parse all reject, which keeps the ferret live: the last is tightened by design (today the unparsed entries were skipped). Board answers only ferret ids (AK-B9…AK-B13; AK-B13: one odd card beside a good one, and the good card's finished ferret still archives): a stored party that is not a ferret id is left out, a card whose owner is not one answers its assignee as owner, and a card with neither is left out, so one odd card never makes the whole answer unreadable; Board checks its answer with Ferrets' contract `ArchiveCardStandingsSchema`, the schema Ferrets parses it with. A quarantined card keeps nobody, as today. NOT carried: today's revive on a card write (`fyd.ts:2087`) and on an agenda ledger write (`fyd.ts:9746`), which needs a retain or revive port in Ferrets' contract (declared in GAP(archive) and docs/session-archive.md). Pinned by `packages/plugins/board/tests/unit/board/archive-keeps.test.ts` and `packages/plugins/agenda/tests/unit/daemon/archive-keeps.test.ts`.",
  '- The login staging route (`POST /v1/logins/changes`, `login.add` and `login.env`) and the Paste variables screen (v4 `paste-variables.tsx` with `provider-model.ts` `prefillFrom` and `one-click-login.tsx` `oneClickDraft`) are tightened by design, not a parity break: v4 copied every pasted plain value into a plain field and accepted any address, so a gateway key typed into a deliberately empty `ANTHROPIC_API_KEY` (Custom gateway, OpenRouter, Vercel AI Gateway) or a `https://user:password@…` address was shown in clear, sent, and written into `logins/<id>.yaml` when short enough to slip past the length floors. 5.0 differs in four ways, all one rule (`plainPaste` in `packages/plugins/logins/contract/secret-shape.ts`): (1) a pasted value is withheld from its plain field when the variable is credential-named, the value is token-shaped, the address carries a user and password (with or without a scheme), or a credential-named query parameter (`?key=…`, `?token=…`, `?sig=…`) holds a key (an Azure-style `…?api-version=…` base URL is still filled in), or a credential-named header line (`Authorization: Bearer …`, `x-api-key: …`, whatever the variable is called) holds a key; (2) the form says which variables were left out, by name and reason, never the value; (3) a pasted value is never copied into a variable the preset leaves empty on purpose, which keeps its `\'\'`; (4) the daemon refuses `login.add` and `login.env` for a value with a token shape, at ANY length, and, under a name with a credential word anywhere in it (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `AUTH`, ...), for every value that is not exactly one allowed shape: a placeholder under 8 characters with no `$` (`OPENAI_API_KEY=ollama`, `dummy`, `hunter2`, accepted as plain by the daemon as in v4, since the secret store cannot hold one either); one `${secret:NAME}` reference, or several with nothing between them; a scheme word (one word of letters and `-`, at most 16 characters, no digit: `Bearer`, `Api-Token`, `ApiKey`) then whitespace then references; a header name, `:` or `=`, then either of those (`Authorization: Bearer ${secret:K}`); `$NAME` or `${NAME}` with an upper-case environment variable name; a number of up to 12 digits or a flag word (`true`, `false`, `yes`, `no`, `on`, `off`, `oauth`, `none`, `apikey`); or one address that passes the address check. It is an allowlist, so a key cannot hide in text a blocklist forgot. Under ANY name the daemon also refuses a header list (any value, such as `ANTHROPIC_CUSTOM_HEADERS`, `OTEL_EXPORTER_OTLP_HEADERS`, `GATEWAY_EXTRA` or a JSON `{"api_key":"…"}` body, split on line ends and commas, a folded line joined, each piece split on its first `:` or `=` and URL-decoded; in a variable named `…HEADER(S)` a header with no credential name is refused too when its value holds a token shape or a key-like run) holding a credential-named header (`Authorization`, `Cookie`, `x-api-key`...) whose value is not a placeholder or a reference, and an address, with or without a scheme, with a literal password, a key as the user (also with an empty password), or a credential-named query or fragment parameter (`key`, `token`, `sig`, `pass`, `pwd`, any `...signature`, its name decoded and trimmed) holding 8 or more characters outside a reference, where v4 refused only values of 8 or more characters (16 for a bare token) and never an address; `AUTH`-style flags (`CLAUDE_CODE_SKIP_BEDROCK_AUTH=1`) and a credential word in the middle of a name (`CLAUDE_CODE_API_KEY_HELPER_TTL_MS=3600000`) are accepted as flags and numbers. The browser still never PREFILLS a pasted value under a name that ends in a credential word into a plain field, whatever its length, except a whole `${secret:NAME}`, and the person types the placeholder themselves. A short `sk-` value is still refused, by its token shape. A `${...}` that is not an upper-case variable name or a valid `${secret:NAME}` is not an indirection. Under a credential name an address is allowed only with an `http`, `https`, `ws`, `wss`, `socks5` or `socks5h` scheme, no fragment, no bare query, short query values and no key-like run (24 or more letters, digits and `_` with a digit and entropy of 3.5 or more), and an absolute or `~/` path is allowed too; a PEM private-key header is a token shape. The rule is a declared heuristic (docs/secrets.md names its residual GAPs). It runs in time linear in the value, and a file value is at most 4096 characters, as on the wire: a longer one is refused and not scanned. The same rule is applied to a login FILE by its schema, so Edit as YAML and `config_write` refuse the same values, naming the variable and never the value, and `config_read` withholds the text of such a file exactly as for a raw key, whatever else is wrong with a file that parses (one refusal of this rule is enough; an `env` that is not a map of NAME: value strings is itself such a refusal), and withholds the text of any login file that fails its check, whatever the reason (a key outside `env`, a file that does not parse as YAML at all): a file that fails is reported invalid; an edit keeps the last good version in effect, but a file saved before this rule is not in effect until it is fixed. Pinned by `packages/plugins/logins/tests/unit/app/sign-ins-tab.test.tsx` ("keeps a pasted gateway key and a user:password address out of every field and out of the staged change") and `packages/plugins/logins/tests/unit/changes/derive.test.ts` ("should refuse a short gateway key under a credential-named variable, naming the variable and never the value").',
  '',
  '## Unplaced rows',
  '',
  ...(unplaced.length ? unplaced.map(row => `- ${row.id}: ${escaped(row.what)} (${row.source})`) : ['None.']),
  '',
  '## Extraction diagnostics',
  '',
  ...(warnings.size
    ? [...warnings].sort().map(warning => `- ${escaped(warning)}`)
    : ['No unresolved Commander declarations.']),
  '',
];
for (const owner of [...owners, ...(unplaced.length ? ['UNPLACED'] : [])]) {
  const owned = inventory.filter(row => row.owner === owner);
  if (!owned.length) continue;
  out.push(
    `## ${owner} (${owned.length})`,
    '',
    '<!-- prettier-ignore -->',
    '| id | Kind | Today | Today’s source | Today’s module | 5.0 owner package | 5.0 name | Descriptor / detail | Check to add | Status |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const row of owned)
    out.push(
      `| ${[row.id, row.kind, row.what, row.source, row.todayOwner, packagePath(row.owner), row.name5, row.descriptor, row.check, row.status].map(escaped).join(' | ')} |`,
    );
  out.push('');
}
// The v4 -> v5 home conversion's rows (lead decision 2026-11-07): owned by the converter at migration/, which
// regenerates this file from its own step table; included verbatim so --check covers it too.
const migrationSection = join(outputDirectory, 'rebuild-parity-migration.md');
if (existsSync(migrationSection)) out.push(readFileSync(migrationSection, 'utf8').trimEnd(), '');
const markdown = `${out.join('\n').trimEnd()}\n`;
if (args.includes('--check')) {
  if (
    !existsSync(markdownPath) ||
    readFileSync(markdownPath, 'utf8') !== markdown ||
    !existsSync(tsvPath) ||
    readFileSync(tsvPath, 'utf8') !== tsv
  )
    throw new Error('Parity artifacts differ. Regenerate with the same reference tree.');
} else {
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(markdownPath, markdown);
  writeFileSync(tsvPath, tsv);
}
console.log(
  JSON.stringify(
    {
      reference: sourceHead,
      total: inventory.length,
      counts: Object.fromEntries(Object.keys(kindNames).map(kind => [kind, count(kind as Kind)])),
      unplaced: unplaced.length,
      removed,
      diagnostics: [...warnings],
    },
    null,
    2,
  ),
);
