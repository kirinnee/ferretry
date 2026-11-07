// Placement rules: which of today's files each 5.0 subsystem copies (docs/design/redesign.md §8, §2.3 "Today").
//
// One rule = [owners, regex source]. The FIRST rule that matches a repo path wins. `owners` is
// `primary` or `primary+also+also`: the primary subsystem lists the file under "Copy from"; each "also" lists it under
// "Also copy (shared)". A leading `!` on the primary means "no subsystem copies this" (see BUCKETS).
//
// Non-subsystem buckets (declared, not unplaced):
//   app-shell   the App shell (§5.1): router, layout engine, slots, theme tokens, sealed session client, daemon list,
//               reference grammar, shared UI primitives. Day-1 spine slice, not one of the 31 ports.
//   fy-shell    the `fy` shell (§10.3): CLI router, terminal ports, command registry. Day-1 spine slice.
//   spine       SDK, generator, contracts plumbing, shared protocol helpers (canonical JSON, common, test support).
//   drop        whole file is compatibility or one-shot code that the clean slate deletes; no port copies it.
//
// Judgment placements (a file whose owner is not named by §8 or the Appendix D enforcer) are marked `~` in the
// rule id column of docs/rebuild/placement.tsv so the lead can reassign them.

export type Rule = readonly [owners: string, source: string, note?: string];

/** Segment helper: a directory or file stem called one of `names`, under a source or test root. */
const roots =
  'lib|adapters|mounts|unit|integration|realworld|sit|contract|support|fixtures|features|hooks|components|modules|shell|harness|public|scripts';
export const seg = (...names: string[]): string => `/(?:${roots})/(?:${names.join('|')})(?:[/.]|$)`;
/** session sub-module helper (daemon lib/adapters/tests mirror each other). */
export const ses = (...names: string[]): string => `/session/(?:${names.join('|')})(?:[/.]|$)`;

const SHARED_HARNESS = 'claude-code+codex';

export const RULES: readonly Rule[] = [
  // ---------------------------------------------------------------- drop: compatibility whole files
  ['!drop:gate', 'daemon/.*/modules/legacy/', 'legacy route contracts'],
  [
    '!drop:asks',
    'daemon/.*(?:agenda-migration|home-migration|machine-migration)\\.',
    'agenda one-shot migrations (#1558)',
  ],
  [
    '!drop:connections',
    'daemon/src/(?:lib|adapters)/runtime/carriers?-conversion|daemon/src/adapters/runtime/carrier-conversion',
    'carriers boot conversion R175-R181',
  ],
  ['!drop:access', 'daemon/.*/(?:retired-password|sharing-follows-pairing)\\.', 'G69-G72, G104, P67 boot repairs'],
  ['!drop:terminals', 'daemon/.*cgroups/legacy(?:-documents)?[.]ts$', 'old cgroup documents'],
  ['!drop:access', 'daemon/.*sharing-repair-notices', 'G69-G72 repair notices'],
  ['!drop:board', 'daemon/.*/legacy-tasks\\.ts$', 'old tasks.json mount'],
  ['!drop:accounts', 'protocol/.*/(?:migrate-login-index|login-index-v1)', 'login index v1->v2 (S69-S75)'],
  ['!drop:kernel', 'protocol/.*/(?:daemon-features|daemon-feature-)', 'feature gates (S133, §9.6 replaces)'],
  ['!drop:kernel', 'protocol/.*/version-skew', 'version floor (c52/pr-16)'],
  ['!drop:asks', 'daemon/.*agenda-legacy-archive-contract', 'old agenda archive'],

  [
    '!drop:connections',
    'daemon/.*(?:carrier-conversion|carriers-conversion|conversion-acceptance)',
    'boot conversion / repair notices',
  ],
  ['browsers', 'daemon/.*/browser/', 'browser runtime'],
  [
    'access+gate',
    'daemon/.*(?:lib|unit|integration)/step-up/(?:service|registry|passkeys-changed|index|types)|daemon/.*adapters/step-up/state-',
    'step-up ceremonies and stores (unlock, passkeys) are Access; plumbing is Gate',
  ],
  ['logins', 'daemon/tests/.*fleet-credentials/', 'fleet credentials tests'],
  ['board', 'daemon/tests/unit/board-import', 'board import adapters'],
  [
    'asks',
    'daemon/bin/agenda-versions[.]worker|daemon/tests/(?:realworld/runtime/agenda-versions|integration/support/slow-agenda-versions|support/(?:agenda-version|file-agenda-versions))',
    'agenda versions are Asks (versions/<ask>.sqlite)',
  ],
  // ---------------------------------------------------------------- daemon: session/* (shared folder, sub-module by sub-module)
  ['agenda', `daemon.*${ses('agenda-mode')}`, 'session agenda mode'],
  [
    'ferrets',
    `daemon.*${ses('archive', 'auto-resume', 'directory', 'effects', 'events', 'launch', 'lifecycle', 'monitor', 'observer', 'provenance', 'restart', 'resume', 'signal', 'snapshot', 'live', 'pack')}`,
    'identity/state machine/launch/lineage',
  ],
  ['ferrets', 'daemon.*/session/(?:reap-service|reap)[.]', 'reap'],
  ['ferrets+terminals', `daemon.*${ses('health')}`, '~ pane health sweep'],
  ['ferrets+runtimes', `daemon.*${ses('runtime-control')}`, '~ runtime switch ledger'],
  ['ferrets+conversation', `daemon.*${ses('filesystem')}`, '~ session file browser; WorkFolders is Ferrets'],
  ['terminals', `daemon.*${ses('console', 'attach', 'processes')}`, 'console input G30, attach proof, processes G34'],
  [SHARED_HARNESS, `daemon.*${ses('permission', 'dialog')}`, 'harness dialogs G31/G32'],
  ['codex+claude-code', 'daemon.*/session/harness/codex-', 'codex half of harness'],
  [SHARED_HARNESS, `daemon.*${ses('harness')}`, '~ shared harness driver; both harness ports copy and split'],
  [
    'conversation',
    `daemon.*${ses('compact-at', 'context', 'hypermedia', 'question', 'queue', 'reads', 'send', 'transcript', 'turn')}`,
    'send/queue/turn/questions/transcript',
  ],
  ['conversation', 'daemon.*/session/conversation-lease', 'conversation lease'],
  ['conversation', 'daemon.*/session/(?:ferretry-senders|owner-session)[.]', '~ owner chat senders'],
  ['ferrets', 'daemon.*/session/(?:index|session-id)[.]', 'session barrel'],
  ['ferrets', 'daemon.*/(?:adapters|lib|tests/[a-z]+)/session[/.]', '~ remaining session files (identity half)'],
  ['ferrets', 'daemon.*session-(?:archive|document|index|state|storage)', '~ session storage'],
  ['ferrets', 'daemon/bin/(?:session|session-index)[.]worker', 'session workers'],
  ['conversation', 'daemon/bin/transcript-parse[.]worker', 'transcript parse worker'],

  // daemon runtime/mounts (source and tests): by mount name PREFIX
  ['!drop:board', 'daemon/.*runtime/mounts/legacy-tasks', 'old tasks.json mount'],
  ['!drop:access', 'daemon/.*runtime/mounts/sharing-repair-notices', 'G69-G72 repair notices'],
  [
    'agenda',
    'daemon/.*runtime/mounts/agenda-(?:machine|open)|daemon/.*runtime/mounts/session-agenda-mode',
    'agenda views',
  ],
  ['asks', 'daemon/.*runtime/mounts/agenda', 'asks store/answer mounts'],
  [
    'accounts',
    'daemon/.*runtime/mounts/(?:account-|accounts-|factor-seed|login-entries|secret-clone|sign-in-rule|task-plan|secure-copy|browser-login)',
    'accounts mounts',
  ],
  ['vault', 'daemon/.*runtime/mounts/(?:secrets|input-requests|secret-write)', 'vault mounts'],
  [
    'gate',
    'daemon/.*runtime/mounts/(?:composed-audit|audit|security|step-up|session-credential|health|doctor)',
    'gate mounts',
  ],
  ['access', 'daemon/.*runtime/mounts/(?:device-grants|grants|pairing|push|unlock-gate)', 'access mounts'],
  [
    'connections',
    'daemon/.*runtime/mounts/(?:carriers|direct-carrier|surface-carrier|tunnel|webrtc)',
    'connections mounts',
  ],
  ['catalogs', 'daemon/.*runtime/mounts/(?:catalog|shared-catalogs|local-skill-installs)', 'catalogs mounts'],
  ['updates', 'daemon/.*runtime/mounts/(?:daemon-update|harness-update|update)', 'updates mounts'],
  ['usage', 'daemon/.*runtime/mounts/(?:analytics|performance)', 'usage mounts'],
  ['projects', 'daemon/.*runtime/mounts/board-projects', 'projects mount'],
  ['board', 'daemon/.*runtime/mounts/board', 'board mount'],
  ['browsers', 'daemon/.*runtime/mounts/browser', 'browser mounts'],
  ['logins', 'daemon/.*runtime/mounts/(?:models|fleet-login)', 'logins mounts'],
  ['runtimes', 'daemon/.*runtime/mounts/(?:fleet-catalog|fleet-setup|recommend)', 'runtimes mounts'],
  [
    'ferrets',
    'daemon/.*runtime/mounts/(?:agent-control|agent-tools|fleet-credentials|names|pins|sessions|session-(?:addressing|archive|control|fork|handover|migrate|pin|rename|restart|resume|runtime|signal|mounts|filesystem)|system-session-control|worktrees)',
    'ferrets mounts',
  ],
  ['claude-code+codex', 'daemon/.*runtime/mounts/(?:session-mcp|session-dialog|session-permission)', 'harness mounts'],
  [
    'conversation',
    'daemon/.*runtime/mounts/(?:conversation-import|foreign-history|imports|renders|shared-drafts|work-search|session-(?:answer|attachments|compact-at|hypermedia|reads|send))',
    'conversation mounts',
  ],
  [
    'terminals',
    'daemon/.*runtime/mounts/(?:terminals|cgroups|session-console|session-processes|session-attach)',
    'terminals mounts',
  ],
  ['lessons', 'daemon/.*runtime/mounts/learning', 'lessons mount'],
  ['mcp', 'daemon/.*runtime/mounts/mcp', 'mcp mounts'],
  ['packs', 'daemon/.*runtime/mounts/pack', 'packs mount'],
  ['voice', 'daemon/.*runtime/mounts/(?:speedups|stt)', 'voice mounts'],
  ['tidy', 'daemon/.*runtime/mounts/(?:tidy|housekeeping|scratch)', 'tidy mounts'],
  ['warden', 'daemon/.*runtime/mounts/warden', 'warden mount'],
  // ---------------------------------------------------------------- daemon: Kernel (runtime/, storage, config, paths, layout)
  [
    'connections',
    'daemon/.*runtime/(?:carriers|published-carriers|mounts/(?:carriers|direct-carrier|tunnel|webrtc))',
    'runtime/carriers*',
  ],
  [
    'gate',
    'daemon/.*runtime/mounts/(?:audit|security|step-up|session-credential|health|doctor)[.]',
    'gate-side mounts',
  ],
  ['vault', 'daemon/.*runtime/mounts/(?:secrets|input-requests|secret-write-grant)[.]', 'vault mounts'],
  ['accounts', 'daemon/.*runtime/mounts/(?:sign-in-rules|secure-copy|task-plans|browser-login)[.]', 'accounts mounts'],
  ['kernel', 'daemon/.*runtime/mounts/(?:config-files|index|fleet-events|staged)[^/]*$', 'config files, mount index'],
  ['agenda', 'daemon/.*runtime/mounts/agenda-(?:machine|open)[.]', 'view half of agenda mounts'],
  ['asks', 'daemon/.*runtime/mounts/agenda[^/]*$', 'agenda mounts: store/answer half'],
  [
    'ferrets',
    'daemon/.*runtime/mounts/(?:agent-control|fleet-(?:catalog|credentials|setup)|names|sessions|session-(?:addressing|archive|control|fork|handover|migrate|pin|rename|restart|resume|runtime|signal)|system-session-control|worktrees|pins)[.]',
    'ferret lifecycle mounts',
  ],
  ['runtimes', 'daemon/.*runtime/mounts/(?:fleet-catalog|recommend)[.]', 'runtime catalog'],
  [
    'conversation',
    'daemon/.*runtime/mounts/(?:conversation-import|foreign-history|imports|renders|shared-drafts|work-search|session-(?:agenda-mode|answer|attach|attachments|compact-at|dialog|filesystem|hypermedia|mcp|permission|reads|send))[.]',
    'conversation mounts',
  ],
  [
    'terminals',
    'daemon/.*runtime/mounts/(?:terminals|cgroups|session-console-input|session-processes)[.]',
    'terminal mounts',
  ],
  [
    'kernel',
    'daemon/.*(?:runtime/(?:arguments|background-lane|boot|config|index|io-pressure|liveness|modules|pass-trigger|provenance|secrets|staged-surface|timings)[.]|runtime/mounts/[^/]*$)',
    'runtime/',
  ],
  ['kernel', `daemon.*${seg('runtime')}`, 'runtime/'],
  [
    'kernel',
    'daemon/.*(?:src/lib/(?:config-files|storage-types|journal|state-home|paths|layout|ports|json|instant|iso-instant|append-only-log|index-writes|index|rebuild|reconciliation|version)|src/adapters/(?:storage|atomic-file|file-events|config-files|filesystem|index|system|runtime))[/.]',
    'storage/journal/paths/layout/ports',
  ],
  [
    'kernel',
    'daemon/.*(?:/(?:config-files|file-events|atomic-file|storage|system)/|tests/(?:unit|integration)/(?:storage|state|sqlite|ordered|oversized|reconciliation|bootstrap|rebuild|index-writes|journal|json|iso-instant|state-home|append-only|package-entry|offline|no-prepend)[^/]*$)',
    'kernel tests',
  ],
  ['kernel', 'daemon/src/[^/]*\\.d\\.ts$', 'asset typings'],
  ['ferrets', 'daemon/src/lib/session-id', 'session id'],
  ['logins', 'daemon/src/adapters/fleet-credentials/', 'fleet credentials adapter'],
  ['kernel', 'daemon/(?:bin/fyd\\.ts|bin/modules/seams\\.ts|package\\.json|tsconfig\\.json|README\\.md)', 'host entry'],
  ['kernel', 'daemon/bin/(?:analytics|agenda-versions)[.]worker', '~ workers; moved by owners below'],

  // ---------------------------------------------------------------- daemon: Gate
  ['gate', `daemon.*${seg('api', 'audit', 'security', 'step-up')}`, 'api/, audit, security, step-up plumbing'],
  [
    'gate',
    'daemon/.*(?:modules/(?:route-contracts|fixtures)|bearer-socket|session-client|frame-envelope|redact-reference)[.]',
    'route-contract / bearer test support',
  ],

  // ---------------------------------------------------------------- daemon: Vault
  ['vault', `daemon.*${seg('input-requests')}`, 'input-requests'],
  [
    'accounts',
    'daemon/.*lib/input-requests/(?:agenda-adapter|login-adapter|login-observer|phone-approval|saved-logins|recognised|rebind|typed-identities)[.]',
    'accounts side of input-requests',
  ],
  ['terminals', 'daemon/.*lib/input-requests/(?:terminal-target|terminal-modes)[.]', 'terminal input target'],
  ['browsers', 'daemon/.*lib/input-requests/page-target[.]', 'page input target'],
  [
    'accounts',
    'daemon/.*(?:lib|adapters)/secrets/(?:accounts|account-defaults|login-recipes|logins|proposal-target|sign-in-context|totp|two-factor-agenda|two-factor-seeds|use)[.]|daemon/.*adapters/secrets/(?:config-secret-recipes|file-login-index-store)[.]',
    'account half of secrets',
  ],
  ['vault', `daemon.*${seg('secrets')}`, 'vault half of secrets'],
  ['vault', 'daemon/.*adapters/runtime/daemon-secrets[.]', 'daemon secrets'],

  // ---------------------------------------------------------------- daemon: Asks vs Agenda
  [
    'asks',
    'daemon.*/agenda/(?:state-machine|service|serial-queue|versions|card-asks|owner-asks|closest|config-confirms|duplicates|item-words|reply-batch|writing-lint|archive|agenda-files|home|index|observers)[.]',
    'asks: store, answers, obligations',
  ],
  [
    'agenda',
    'daemon.*/agenda/(?:machine-agenda|rollup|rest-nudge|turn-nudge|waker|resurfacer|stopped|owner-chat|conversation|clear-agents|harness-prompt)[.]',
    'agenda: views, buzz, nudges',
  ],
  ['asks+agenda', `daemon.*${seg('agenda')}`, '~ remaining agenda tests'],
  [
    'agenda',
    'daemon/bin/agenda-versions[.]worker|daemon/tests/support/(?:agenda-|machine-agenda|file-agenda)',
    '~ agenda versions worker',
  ],
  ['agenda', `daemon.*${seg('notifications')}`, 'notifications'],

  // ---------------------------------------------------------------- daemon: Ferrets
  [
    'ferrets',
    `daemon.*${seg('names', 'fleet-reading', 'fleet-refresh', 'sub-ferret', 'worktrees', 'git', 'pins', 'agent-pins', 'fork', 'handover', 'migrate', 'transfer', 'agent-tools')}`,
    'names, fleet, lineage, worktrees, fork/handover/migrate/transfer',
  ],
  [
    'logins+runtimes',
    'daemon/.*(?:lib|adapters)/fleet/(?:credentials-service|launch-renewal|launch-environment|secret-references)[.]',
    'fleet credentials',
  ],
  [
    'runtimes',
    'daemon/.*(?:lib|adapters)/fleet/(?:catalog|catalog-service|setup-service|setup-files|resolved-view|runtime-ids-file|runtime-session-records|runtime-sessions|codex-runtime|account-model-files|manifest-file|proposals|publication|tool-install|disabled-view|disable-expiry)[.]',
    'runtime setup/catalog',
  ],
  ['ferrets', `daemon.*${seg('fleet')}`, 'fleet (identity, control, start resolution)'],

  // ---------------------------------------------------------------- daemon: Access / Connections
  ['access', `daemon.*${seg('pairing', 'passkeys', 'grants', 'push')}`, 'pairing, passkeys, grants, push'],
  ['connections', `daemon.*${seg('tunnel', 'webrtc')}`, 'tunnel, webrtc'],
  [
    'kernel+connections',
    'daemon.*/(?:lib|adapters|unit|integration)/relay/(?:identity|session-traffic|member-port|answer|web-crypto-relay-identity)[.]',
    'session layer of relay',
  ],
  ['connections', `daemon.*${seg('relay')}`, 'relay (carrier half)'],

  // ---------------------------------------------------------------- daemon: plugins
  ['updates', `daemon.*${seg('update', 'harness-update')}`, 'update'],
  ['claude-code+codex', `daemon.*${seg('agent-files', 'session-mcp')}`, 'agent-files, session-mcp (harness halves)'],
  [
    'logins',
    `daemon.*${seg('fleet-login', 'provider-probe', 'models', 'local-models')}`,
    'fleet-login, provider-probe, models',
  ],
  ['terminals', `daemon.*${seg('terminal', 'tmux', 'cgroups', 'process')}`, 'terminal, tmux, cgroups, processes'],
  ['browsers', `daemon.*${seg('browser', 'browser-proxy')}`, 'browser'],
  ['accounts', `daemon.*${seg('sign-in-rules', 'sign-in-grants', 'secure-copy')}`, 'sign-in rules, secure copy'],
  ['board', `daemon.*${seg('board', 'board-github', 'board-import', 'task-plans')}`, 'board'],
  ['projects', `daemon.*${seg('board-projects')}`, 'projects'],
  [
    'conversation',
    `daemon.*${seg('attachments', 'renders', 'shared-drafts', 'imports', 'work-search', 'transcript')}`,
    'conversation',
  ],
  ['packs', `daemon.*${seg('pack', 'speedups')}`, 'pack (speedups shared with Voice)'],
  ['warden', `daemon.*${seg('warden')}`, 'warden'],
  ['usage', `daemon.*${seg('usage', 'budget', 'analytics', 'performance')}`, 'usage'],
  ['lessons', `daemon.*${seg('learning')}`, 'learning'],
  ['voice', `daemon.*${seg('stt')}`, 'stt'],
  [
    'catalogs',
    `daemon.*${seg('shared-catalogs', 'catalog', 'catalog-installs', 'catalog-links', 'catalog-members', 'local-skill-installs')}`,
    'catalogs',
  ],
  ['mcp', `daemon.*${seg('mcp-inventory', 'mcp-oauth', 'mcp')}`, 'mcp'],
  ['skills', `daemon.*${seg('skills')}`, 'skills'],
  ['tidy', `daemon.*${seg('housekeeping', 'tidy', 'scratch')}`, 'housekeeping, tidy, scratch'],
  ['onboarding', 'daemon/.*(?:lib|adapters)/fleet/setup', 'fleet setup scan'],
  ['kernel', `daemon.*${seg('core')}`, '~ lib/core: advisor, doctor, inventory, planner (daemon-wide helpers)'],
  ['ferrets', 'daemon/bin/modules/names[.]|daemon/bin/modules/worktrees[.]', 'module wiring'],
  ['logins', 'daemon/bin/modules/(?:fleet-login|models)[.]', 'module wiring'],
  ['terminals', 'daemon/bin/modules/(?:terminal|cgroups)[.]', 'module wiring'],
  ['browsers', 'daemon/bin/(?:modules/browser[.]|browser-worker)', 'module wiring'],
  [
    'conversation',
    'daemon/bin/(?:modules/(?:conversation-import|renders|shared-drafts|work-search)[.]|pdf-decrypt)',
    'module wiring',
  ],
  ['vault', 'daemon/bin/modules/input-requests[.]', 'module wiring'],
  ['usage', 'daemon/bin/(?:modules/(?:usage|analytics)[.]|analytics-)', 'module wiring'],
  ['lessons', 'daemon/bin/modules/learning[.]', 'module wiring'],
  ['mcp', 'daemon/bin/modules/mcp[.]', 'module wiring'],
  ['tidy', 'daemon/bin/(?:modules/housekeeping[.]|housekeeping[.]worker)', 'module wiring'],
  ['updates', 'daemon/bin/modules/update[.]', 'module wiring'],
  ['voice', 'daemon/bin/modules/voice[.]', 'module wiring'],
  ['ferrets', 'daemon/bin/modules/(?:agent-tools|transfer)[.]', 'module wiring'],

  // daemon fixtures and support
  [
    SHARED_HARNESS,
    'daemon/tests/fixtures/(?:harness-dialogs|permission-prompts|startup-dialogs|codex|compaction)/',
    'harness fixtures',
  ],
  [
    'conversation',
    'daemon/tests/fixtures/(?:composer|question-forms|question-asked|transcript)/|daemon/tests/(?:support/(?:transcript-images|renders|referenced-chat|session-owner-chat)|fixtures/docx)',
    'conversation fixtures',
  ],
  ['access', 'daemon/tests/(?:fixtures/(?:pairing|push)/|support/passkey-authenticator)', 'access fixtures'],
  [
    'terminals',
    'daemon/tests/(?:fixtures/ps/|integration/support/(?:claude-pane|fake-tmux-server|fleet-panes|recorded-pane))',
    'terminal fixtures',
  ],
  ['warden', 'daemon/tests/fixtures/warden/', 'warden fixtures'],
  ['connections', 'daemon/tests/integration/support/(?:webrtc-|os-port)', 'connections support'],
  [
    'usage',
    'daemon/tests/integration/support/(?:analytics-fixtures|fake-usage-server|slow-analytics-writer)',
    'usage support',
  ],
  ['tidy', 'daemon/tests/integration/support/housekeeping-', 'tidy support'],
  ['catalogs', 'daemon/tests/support/catalog-fixtures', 'catalogs support'],
  ['kernel', 'daemon/tests/(?:support|integration/support|contract|fixtures)/', '~ shared daemon test support'],
  ['conversation', 'daemon/tests/contract/question-hook', 'question hook contract'],
  ['kernel', 'daemon/tests/', '~ daemon tests with no domain'],

  // ---------------------------------------------------------------- protocol (dissolves into contracts)
  ['asks+agenda', 'protocol/.*(?:lib|unit)/agenda(?:-[a-z-]+)?[.]', 'agenda wire shapes'],
  ['asks+agenda', 'protocol/.*unit/agenda', 'agenda wire tests'],
  [
    'board',
    'protocol/.*/(?:lib|unit)/(?:board(?:-(?:history|import|lanes|patch|refs|reopen[a-z-]*|lane-stages))?|tasks|task-title|task-plan|work-management|code-cards)[.]',
    'board wire',
  ],
  ['projects', 'protocol/.*/(?:lib|unit)/board-projects[.]', 'projects wire'],
  [
    'accounts',
    'protocol/.*/(?:lib|unit)/(?:account-factor-routes|accounts|account-ids|login-entries|login-recipes|phone-approval|secure-copy|secret-clone|sign-in-rules|two-factor|task-plan)[.]',
    'accounts wire',
  ],
  ['vault', 'protocol/.*/(?:lib|unit)/(?:input-request|input-lock|secrets)[.]', 'vault wire'],
  [
    'access',
    'protocol/.*/(?:lib|unit)/(?:pairing|pairing-redirect|push|grants|read-capability-grants|step-up)[.]|protocol/.*pairing-redirect-sweep',
    'access wire',
  ],
  ['gate', 'protocol/.*/(?:lib|unit)/(?:audit|security|config-changes)[.]', 'gate wire'],
  [
    'kernel',
    'protocol/.*/(?:lib|unit)/(?:config-files|state-home-layout|canonical-json|tcp-listeners|process-incarnation|daemon-restart|io-pressure|daemon-runtime-tuning|loopback-firewall|advertisement|address|doctor|surface|surface-names)[.]|protocol/.*process-incarnation',
    'kernel wire',
  ],
  ['connections', 'protocol/.*/(?:lib|unit)/(?:carriers|relay-session|tunnel|webrtc)[.]', 'connections wire'],
  ['updates', 'protocol/.*/(?:lib|unit)/(?:daemon-update|harness-update)[.]', 'updates wire'],
  ['logins', 'protocol/.*/(?:lib|unit)/(?:harness-login|models)[.]', 'logins wire'],
  ['runtimes', 'protocol/.*/(?:lib|unit)/(?:fleet-(?:catalog|changes|setup|clone[a-z-]*)|limits)[.]', 'runtimes wire'],
  ['logins+runtimes', 'protocol/.*/(?:lib|unit)/fleet-credentials[.]', 'fleet credentials wire'],
  ['terminals', 'protocol/.*/(?:lib|unit)/(?:terminal|session-processes)[.]', 'terminal wire'],
  ['browsers', 'protocol/.*/(?:lib|unit)/browser[a-z-]*[.]', 'browser wire'],
  ['usage', 'protocol/.*/(?:lib|unit)/(?:analytics[a-z-]*|performance[a-z-]*)[.]', 'usage wire'],
  ['lessons', 'protocol/.*/(?:lib|unit)/(?:learning|agent-tools-lessons)[.]', 'lessons wire'],
  ['voice', 'protocol/.*/(?:lib|unit)/(?:stt[a-z-]*)[.]', 'voice wire'],
  ['packs', 'protocol/.*/(?:lib|unit)/(?:pack[a-z-]*|speedups)[.]', 'packs wire'],
  ['warden', 'protocol/.*/(?:lib|unit)/warden[.]|protocol/.*fixtures/warden', 'warden wire'],
  [
    'catalogs',
    'protocol/.*/(?:lib|unit)/(?:catalog[a-z-]*|shared-catalog[a-z-]*|local-skill-install)[.]|protocol/.*fy-api-client-(?:catalog|local-skill)',
    'catalogs wire',
  ],
  ['mcp', 'protocol/.*/(?:lib|unit)/(?:mcp-inventory|mcp-oauth|session-mcp)[.]', 'mcp wire'],
  ['skills', 'protocol/.*/(?:lib|unit)/skills-inventory[.]', 'skills wire'],
  ['tidy', 'protocol/.*/(?:lib|unit)/tidy[.]', 'tidy wire'],
  ['projects', 'protocol/.*/(?:lib|unit)/worktrees[.]', '~ worktrees'],
  [
    'ferrets',
    'protocol/.*/(?:lib|unit)/(?:agent-address|agent-messages|agent-tools|auto-resume|handover|pins|session-(?:base|fork|live|restart|revive|subtree|transfer(?:-edge)?|provenance|list-sharing|context|service)|system-callsigns|worktrees|fleet-clone[a-z-]*|session)[.]|protocol/.*fork-fixtures',
    'ferrets wire',
  ],
  [
    'conversation',
    'protocol/.*/(?:lib|unit)/(?:compact-at|conversation-import|foreign-history|session-(?:compact-at|dialog|filesystem|permission|queue(?:-wait)?|search|transcript)|renders|render-save|shared-draft|transcript-images|turn-handoff|work-search)[.]|protocol/.*fy-api-client-(?:log|fork|handover|session|streaming|start)',
    'conversation wire',
  ],
  ['claude-code+codex', 'protocol/.*/(?:lib|unit)/(?:session-dialog|session-permission)[.]', 'dialogs wire'],
  [
    'app-shell',
    'protocol/.*/(?:lib|unit)/(?:fy-render[a-z-]*|plain-label|common|client|service|schema-cases|package-entry|common-version|one-source-words|performance-render)[.]',
    'shared render/words helpers',
  ],
  ['spine', 'protocol/', 'protocol remainder: SDK contracts plumbing'],

  // ---------------------------------------------------------------- fleet package
  [
    'logins',
    'fleet/(?:src|tests)/.*(?:anthropic-usage-probe|codex-usage-probe|credential|token-refresh|process-token|rollout-rate|quota|usage|models|keychain|account-(?:credential|environment|budget))',
    'logins',
  ],
  ['logins', 'fleet/models/', 'model catalogs as data'],
  ['logins', 'fleet/presets/', 'provider presets as data (endpoint kind)'],
  ['codex', 'fleet/codex/|fleet/.*codex', 'codex defaults'],
  ['claude-code', 'fleet/.*claude', 'claude launch/store'],
  [
    'runtimes',
    'fleet/(?:src|tests)/.*(?:account|presets|settings|built-ins|defaults|env-profiles|harness|identity|manifest|provisioning|assets|wrappers?|file-provisioner|host-harness|wrapper)',
    'accounts/profiles/runtimes',
  ],
  [
    'kernel',
    'fleet/(?:src|tests)/.*(?:config-files|paths|state-home|fence|guard|node-guard|user-home|working-directory|directory|descriptor|link-syscall|destination|apply-lock|mutation-journal|fenced|replaceable|fake-guard)',
    'fence/descriptor io',
  ],
  ['conversation', 'fleet/.*(?:conversation-lease|shared-history|question-hook)', 'conversation lease/shared history'],
  ['runtimes', 'fleet/', 'fleet remainder: setup, profiles'],

  // ---------------------------------------------------------------- relay package
  [
    'catalogs',
    'relay/(?:src|tests).*(?:link-store|link-bundle|catalog-signature|catalog-versions|link-signature|member-session|links|link-store-fakes)',
    'link-store Worker (catalogs/worker)',
  ],
  ['catalogs', 'relay/wrangler.link-store', 'link-store Worker config'],
  [
    'connections',
    'relay/(?:src|tests).*(?:hosted|tunnel|rendezvous|tenancy|operator-auth|control|cloudflare|workers-fakes|worker|end-to-end|memory-tunnel|relay-worker|connection)',
    'relay Worker, tunnel control',
  ],
  ['connections', 'relay/wrangler|relay/README|relay/package|relay/tsconfig', 'relay Worker package'],
  [
    'kernel',
    'relay/(?:src|tests).*(?:binary|channel|claim|crypto|device-proof|flow|frames|handshake|identity|constants|webcrypto|index)',
    'session layer: sealing, frames, handshake, permits',
  ],
  ['kernel', 'relay/', 'relay remainder: session layer'],

  // ---------------------------------------------------------------- cli (old packages/cli): CLI half of each subsystem
  ['agenda+asks', 'cli/.*/(?:agenda|plan)[/.]|cli/tests/sit/agenda', 'fy agenda / fy ask'],
  ['board', 'cli/.*/(?:board|board-import|board-lanes|tasks|progress)[/.]|cli/tests/sit/card-visibility', 'fy task'],
  ['projects', 'cli/.*/(?:projects)[/.]', 'fy project'],
  ['packs', 'cli/.*/(?:pack|stop)[/.]', 'fy new / fy recommend'],
  [
    'access',
    'cli/.*/(?:pair|passkey|device|grants)[/.]|cli/tests/sit/(?:passkey|device-revoke)',
    'fy pair / fy device',
  ],
  ['connections', 'cli/.*/(?:tunnel|firewall)[/.]', 'fy tunnel'],
  ['updates', 'cli/.*/(?:update)[/.]|cli/tests/realworld/update|cli/tests/sit/clone-update', 'fy update'],
  ['accounts', 'cli/.*/(?:secrets|rules|credential)[/.]|cli/tests/sit/account-model', 'fy account / fy secret'],
  ['vault', 'cli/.*/(?:input)[/.]', 'fy input'],
  ['browsers', 'cli/.*/(?:browser)[/.]|cli/tests/sit/browser-stop', 'fy browser'],
  ['terminals', 'cli/.*/(?:terminal|terminal-slots|terminal-adapters)[/.]', 'fy terminal'],
  [
    'conversation',
    'cli/.*/(?:queue|reads|import|history|render|work-search|filesystem)[/.]|cli/tests/sit/(?:import-conversations|history-claim)',
    'fy send / fy read / fy import',
  ],
  ['ferrets', 'cli/.*/(?:session|worktrees|machine|restart|pins|harness)[/.]', 'fy ferret commands'],
  ['runtimes', 'cli/.*/(?:fleet|profile|runtime|models|setup)[/.]', 'fy runtime / profile'],
  ['logins', 'cli/.*/(?:models)[/.]', 'fy login'],
  ['usage', 'cli/.*/(?:analytics)[/.]', 'fy usage'],
  ['lessons', 'cli/.*/(?:learning|lesson|instructions)[/.]', 'fy lesson'],
  ['voice', 'cli/.*/(?:stt)[/.]', 'fy voice'],
  [
    'catalogs',
    'cli/.*/(?:catalog|catalog-install|catalog-share|local-skill-install)[/.]|cli/tests/sit/catalog-install',
    'fy catalog',
  ],
  ['mcp', 'cli/.*/(?:mcp)[/.]|cli/bin/mcp-group', 'fy mcp'],
  ['tidy', 'cli/.*/(?:tidy|scratch)[/.]', 'fy tidy'],
  ['onboarding', 'cli/.*/(?:onboard)[/.]', 'fy onboard'],
  [
    'kernel',
    'cli/.*/(?:daemon|config|state-home|machine|migration|version)[/.]|cli/tests/(?:realworld/daemon|integration/install-contract)',
    'fy daemon',
  ],
  ['gate', 'cli/.*/(?:security|audit|notify)[/.]', 'fy audit'],
  ['app-shell', 'cli/.*/(?:component|statusline|entry|patch)[/.]', '~ cli shared'],
  ['fy-shell', 'cli/', 'cli remainder: router, terminal ports, registry'],

  // ---------------------------------------------------------------- pwa (old packages/pwa): app half of each subsystem
  [
    'accounts',
    'pwa/.*/(?:features/(?:accounts|secrets|secure-copy)|account-[a-z-]+|accounts-screen-model|secure-copy|sign-in-rule[a-z-]*)(?:[/.]|$)',
    'accounts app',
  ],
  [
    'agenda+asks',
    'pwa/.*/(?:features/agenda|agenda[a-z-]*|use-agenda[a-z-]*|inbox[a-z-]*|machine-agenda|needs-you-row-actions|awaiting-owner|approval-card|reply-approval|answer-chip|gate-items)(?:[/.]|$)',
    'agenda app',
  ],
  [
    'board',
    'pwa/.*/(?:features/(?:board|tasks)|board[a-z-]*|use-board[a-z-]*|card-kind|lane-editor-model|task-[a-z-]+|use-project-cards)(?:[/.]|$)',
    'board app',
  ],
  [
    'projects',
    'pwa/.*/(?:features/projects|projects[a-z-]*|use-project[a-z-]*|use-work-project-names)(?:[/.]|$)',
    'projects app',
  ],
  [
    'browsers',
    'pwa/.*/(?:features/browser|browser[a-z-]*|remote-browser|use-remote-browser)(?:[/.]|$)',
    'browsers app',
  ],
  [
    'catalogs',
    'pwa/.*/(?:features/(?:catalogs|sharing)|catalog[a-z-]*|member-[a-z-]+|shared-reads|release-[a-z-]+)(?:[/.]|$)',
    'catalogs app',
  ],
  ['skills', 'pwa/.*/features/skills/', 'skills app'],
  ['mcp', 'pwa/.*/(?:features/mcp|mcp-callback-page)(?:[/.]|$)', 'mcp app'],
  [
    'connections',
    'pwa/.*/(?:features/(?:carrier|connection)|carrier[a-z-]*|relay-[a-z-]+|relay|connection[a-z-]*|daemon-transport|event-transport|tunnel[a-z-]*|webrtc-carrier|store-carrier[a-z-]*|use-carrier[a-z-]*|use-connection-health|store-connection-health|pairing-unreachable)(?:[/.]|$)',
    'connections app',
  ],
  [
    'access',
    'pwa/.*/(?:features/(?:pairing|device-notice|step-up)|pair-scan|pairing[a-z-]*|passkey[a-z-]*|device-[a-z-]+|push-[a-z-]+|step-up[a-z-]*|store-step-up-request|grants|qr-[a-z-]+|use-qr-scan|security-[a-z-]+|key-rotation|sign-in-rule-step-up)(?:[/.]|$)',
    'access app',
  ],
  [
    'updates',
    'pwa/.*/(?:features/(?:restart-outdated|whats-new|install)|use-service-worker-update|app-updated-toast|install-prompt|changelog|instructions-update|revive-offer)(?:[/.]|$)',
    'updates app',
  ],
  [
    'onboarding',
    'pwa/.*/(?:features/onboarding|get-started[a-z-]*|landing[a-z-]*)(?:[/.]|$)|pwa/get-started',
    'onboarding app',
  ],
  [
    'usage',
    'pwa/.*/(?:features/analytics|usage[a-z-]*|use-usage|use-spend-today|quota-readout|insights-[a-z-]+|performance[a-z-]*)(?:[/.]|$)',
    'usage app',
  ],
  ['warden', 'pwa/.*/(?:features/warden|use-warden[a-z-]*)(?:[/.]|$)', 'warden app'],
  ['lessons', 'pwa/.*/(?:features/learning|learning-api)(?:[/.]|$)', 'lessons app'],
  [
    'voice',
    'pwa/.*/(?:features/speedups|stt|dictation[a-z-]*|voice-chat[a-z-]*|read-aloud|use-auto-read|use-dictation|use-live-voice-settings|auto-read-settings|store-dictation-debug|store-landing-voices|use-parakeet-install|composer-dictation|input-waveform|speed-bench)(?:[/.]|$)|pwa/speed-bench',
    'voice app',
  ],
  ['packs', 'pwa/.*/(?:features/pack|pack[a-z-]*|sub-ferret[a-z-]*)(?:[/.]|$)', 'packs app'],
  [
    'terminals',
    'pwa/.*/(?:terminal[a-z-]*|session-terminal-deck[a-z-]*|web-terminals|session-processes)(?:[/.]|$)',
    'terminals app',
  ],
  [
    'claude-code+codex',
    'pwa/.*/(?:features/(?:harness-dialog|permission-request)|harness-dialogs|harness-event-row|permission-requests|dialog-card)(?:[/.]|$)',
    'dialogs app',
  ],
  ['vault', 'pwa/.*/(?:features/input-request|input-api)(?:[/.]|$)', 'input requests app'],
  ['tidy', 'pwa/.*/(?:tidy[a-z-]*|disk-pressure)(?:[/.]|$)', 'tidy app'],
  [
    'conversation',
    'pwa/.*/(?:features/(?:occupied-composer|queue-view|session-search|stuck-messages|unconfirmed-send|hypermedia|context-rail)|composer[a-z-]*|send-[a-z-]+|sent-message|own-send-row|queue-[a-z-]+|ledger-[a-z-]+|drafts|shared-draft[a-z-]*|attachment[a-z-]*|transcript[a-z-]*|chat-[a-z-]+|question-[a-z-]+|compaction-[a-z-]+|user-message|jump-to-latest|handoff-message|settled-send-note|peer-delivery|unsent|live-markdown[a-z-]*|session-chat[a-z-]*|session-search|work-search[a-z-]*|use-work-search|use-kept-draft|imported-history-page|quote|reference[a-z-]*|slash-commands|md-compose|markdown[a-z-]*|message-[a-z-]+|use-stick-to-bottom-memory|thinking-indicator|tool-[a-z-]+|system-blocks[a-z-]*)(?:[/.]|$)',
    'conversation app',
  ],
  [
    'runtimes',
    'pwa/.*/(?:runtime-[a-z-]+|model-[a-z-]+|use-needs-runtime|fast-mode|mode-badge|local-models[a-z-]*|use-account-picker)(?:[/.]|$)',
    'runtimes app',
  ],
  [
    'layouts',
    'pwa/.*/(?:features/workspace|workspace-layout[a-z-]*|side-pane[a-z-]*|use-layout-mode|no-left-rails|view-tabs)(?:[/.]|$)',
    'layouts app (today hard-coded in App.tsx)',
  ],
  [
    'ferrets',
    'pwa/.*/(?:features/(?:fleet|session-actions|session-info)|fleet-[a-z-]+|agent-[a-z-]+|callsign|lineage|session-(?:actions|activity|cache|cache-storage|cards|dashboard[a-z-]*|event-stream-model|root|screens|title|top-bar|workspace-model|account-names)|sessions-[a-z-]+|use-fleet-view|use-archived-sessions|rename-sheet|migrate-[a-z-]+|new-session-page|live-activity|live-counter|pane-activity|presence|use-machine[a-z-]*|machine-[a-z-]+|all-machines|daemon-[a-z-]+|use-daemon-health|use-dashboard-view)(?:[/.]|$)',
    'ferrets app',
  ],
  // pwa second pass: flat test/feature stems
  [
    'conversation',
    'pwa/.*fy-render|pwa/scripts/build-fy-render|pwa/scripts/build-composer|pwa/.*(?:hypermedia-api|compact-at-api|use-chat-[a-z-]+|use-send-view|use-shared-draft|use-composer-preferences|peer-[a-z-]+|ferretry-sender|stuck-message|use-ferret-cards|code-span-references|highlight|ansi|remark-table|table-view-preference|keyboard-capture|use-stick-to-bottom|use-read-aloud|pre-paint)',
    'fy-render, composer, transcript helpers',
  ],
  ['warden', 'pwa/.*(?:warden|ask-warden)', 'warden app'],
  [
    'voice',
    'pwa/(?:src/worker/(?:parakeet|sherpa|vosk|whisper)|vendor/|harness/(?:parakeet|sherpa|vosk|whisper|stt-|turn-endpointer))|pwa/.*(?:use-stt-settings|use-dictation-shortcut|speedup-keys|voice-(?:engine|cleanup)|fake-speech|tests/unit/stt)|pwa/scripts/build-model-catalog',
    'voice app + workers',
  ],
  ['usage', 'pwa/.*(?:analytics|pricing|global-analytics|session-analytics)', 'usage app'],
  ['connections', 'pwa/.*(?:hosted-relay|active-carrier|use-active-carrier|webrtc-engine-bench)', 'connections app'],
  ['onboarding', 'pwa/.*(?:onboarding|first-run|setup-diagram|setup-handoff)', 'onboarding app'],
  [
    'board',
    'pwa/.*(?:lane-editor|lane-proposal|card-pull-requests|project-lanes|project-board-switch|inbox-board)',
    'board app',
  ],
  ['projects', 'pwa/.*(?:project|add-project)', 'projects app'],
  [
    'access',
    'pwa/.*(?:grants|add-device|pair-phone|pair-scanner|capability-list|use-device-permissions|pair-from-menu)',
    'access app',
  ],
  [
    'accounts',
    'pwa/.*(?:phone-approval|two-factor|login-form|login-recipe|logins-|secrets-card|secret-copy|copy-plan|copy-rules|secure-copy|accounts-|automatic-codes|rule-deep-link|input-card-sign-in|input-card-task-plan|mcp-sign-in)',
    'accounts app',
  ],
  ['vault', 'pwa/.*input-card', 'input cards app'],
  ['catalogs', 'pwa/.*(?:features/shared|update-install-sheet|shared-(?:with-me|entry|screens))', 'catalogs app'],
  ['skills', 'pwa/.*(?:skills-|session-skills|local-skills)', 'skills app'],
  [
    'browsers',
    'pwa/.*(?:unified-browser|in-app-browser|use-session-browser|remote-browser|real-chrome)',
    'browsers app',
  ],
  ['terminals', 'pwa/.*(?:processes-surface|console-surface)', 'terminals app'],
  ['kernel', 'pwa/.*(?:config-files|doctor-settings|about-machine|config-change)', 'kernel app: config files, doctor'],
  [
    'ferrets',
    'pwa/.*(?:limits-settings|pin-(?:bridge|client|store)|files-[a-z-]+|file-tree|file-instance|rich-file-preview|image-viewer|use-ferret-callsigns)',
    'ferrets app: limits, pins, files',
  ],
  ['runtimes', 'pwa/.*engine-catalog-list', 'runtimes app'],
  [
    'agenda',
    'pwa/.*(?:notification|notify|agenda|to-test|answer-quickly|snooze|answered-suggest|resolved-item|card-meta-line|card-kind-chip|use-item-lifecycle|item-conversation|use-group-needs-you|use-done-close|waiting-fold|use-chat-card|use-touch-affected|use-settled-busy)',
    'agenda app',
  ],
  ['layouts', 'pwa/.*(?:workspace-|session-workspace|use-workspace|workspace-rail)', 'layouts app'],
  ['app-shell', 'pwa/harness/|pwa/', 'pwa remainder: shell, UI primitives, router, theme, sealed client, dev harness'],
];
