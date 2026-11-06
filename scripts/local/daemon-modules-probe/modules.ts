/**
 * The proposed daemon modules (`docs/design/daemon-plugins.md` §5), as the feature folders each one owns.
 *
 * A key is a feature folder under `packages/daemon/src/{lib,adapters}` or `packages/daemon/tests/{unit,integration}`
 * (`board`), a session subfolder (`session/send`), or a mount file (`mount:board`). It is the one map every probe
 * script shares, so the line attribution and the commit classification cannot disagree about a folder.
 */

export const MODULES: Record<string, readonly string[]> = {
  kernel: [
    'api',
    'core',
    'runtime',
    'performance',
    'legacy-wire',
    'file-events',
    'atomic-file',
    'filesystem',
    'process',
    'system',
    'storage',
    'git',
    'mount:index',
    'mount:health',
    'mount:doctor',
    'mount:performance',
    'mount:system-open',
    'mount:session-addressing',
    'mount:agent-control',
    '(root)',
    'support',
    'mount:support',
    'mount:surface',
    'mount:route-callers',
    'mount:state-homes-support',
    'mount:second-line',
  ],
  access: [
    'grants',
    'step-up',
    'passkeys',
    'security',
    'audit',
    'mount:grants',
    'mount:step-up',
    'mount:security',
    'mount:audit',
  ],
  pairing: ['pairing', 'push', 'mount:pairing', 'mount:push', 'mount:device-grants'],
  reach: ['relay', 'webrtc', 'tunnel', 'mount:carriers', 'mount:direct-carrier', 'mount:tunnel', 'mount:webrtc'],
  secrets: [
    'secrets',
    'secure-copy',
    'sign-in-rules',
    'sign-in-grants',
    'mount:secrets',
    'mount:secure-copy',
    'mount:sign-in-rules',
    'mount:secret-write-grant',
    'mount:account-defaults',
    'mount:accounts-routes',
    'mount:factor-seed-routes',
    'mount:login-entries',
    'mount:secret-clone',
    'mount:secrets-agent-caller',
    'mount:sign-in-rule-routes',
    'mount:unlock-gate',
  ],
  fleet: [
    'fleet',
    'fleet-reading',
    'fleet-refresh',
    'fleet-credentials',
    'mount:fleet-catalog',
    'mount:fleet-credentials',
    'mount:fleet-setup',
    'mount:fleet-events',
  ],
  'fleet-login': ['fleet-login', 'mount:fleet-login'],
  models: ['models', 'local-models', 'provider-probe', 'mount:models', 'mount:recommend'],
  usage: ['usage', 'budget'],
  cgroups: ['cgroups', 'mount:cgroups'],
  catalogs: [
    'catalog',
    'catalog-installs',
    'catalog-links',
    'catalog-members',
    'shared-catalogs',
    'skills',
    'local-skill-installs',
    'mount:catalogs',
    'mount:catalog-installs',
    'mount:catalog-links',
    'mount:catalog-members',
    'mount:shared-catalogs',
    'mount:catalog-links-boundary',
    'mount:local-skill-installs',
  ],
  mcp: ['mcp-inventory', 'mcp-oauth', 'session-mcp', 'mount:mcp-inventory', 'mount:mcp-oauth', 'mount:session-mcp'],
  agenda: [
    'agenda',
    'notifications',
    'session/agenda-mode',
    'mount:agenda',
    'mount:agenda-clear',
    'mount:agenda-confirms',
    'mount:agenda-gates',
    'mount:agenda-machine',
    'mount:agenda-open',
    'mount:session-agenda-mode',
    'mount:agenda-delivery',
    'mount:agenda-wire',
  ],
  'input-requests': ['input-requests', 'mount:input-requests'],
  board: [
    'board',
    'board-projects',
    'task-plans',
    'mount:board',
    'mount:board-projects',
    'mount:task-plans',
    'mount:task-plan-routes',
  ],
  'board-github': ['board-github'],
  'work-search': ['work-search', 'mount:work-search'],
  pack: ['pack', 'sub-ferret', 'session/pack', 'mount:pack'],
  names: ['names', 'mount:names'],
  // `quota-failover` was the Warden's automatic migration until it was retired; its history belongs to the warden.
  warden: ['warden', 'quota-failover', 'mount:warden', 'mount:warden-branches'],
  analytics: ['analytics', 'mount:analytics', 'mount:analytics-pricing'],
  learning: ['learning', 'mount:learning'],
  terminal: [
    'terminal',
    'tmux',
    'session/console',
    'mount:terminals',
    'mount:session-console-input',
    'mount:terminals-branches',
  ],
  browser: ['browser', 'mount:browser-login', 'mount:browser-proxy'],
  'agent-tools': [
    'agent-tools',
    'agent-files',
    'agent-pins',
    'pins',
    'mount:agent-tools',
    'mount:pins',
    'mount:session-pin',
  ],
  'config-files': ['config-files', 'mount:config-files'],
  housekeeping: ['housekeeping', 'scratch', 'tidy', 'speedups', 'mount:scratch-gc', 'mount:tidy', 'mount:speedups'],
  renders: ['renders', 'mount:renders'],
  'shared-drafts': ['shared-drafts', 'mount:shared-drafts'],
  voice: ['stt', 'mount:stt'],
  transfer: ['transfer', 'attachments', 'mount:session-attachments'],
  'conversation-import': ['imports', 'mount:conversation-import', 'mount:foreign-history'],
  update: ['update', 'harness-update', 'mount:daemon-update', 'mount:harness-update'],
  worktrees: ['worktrees', 'mount:worktrees'],
  'session-migrate': ['migrate', 'mount:session-migrate'],
  'session-fork': ['fork', 'mount:session-fork'],
  'session-handover': ['handover', 'mount:session-handover'],
  'session-messaging': [
    'session/send',
    'session/queue',
    'session/signal',
    'session/question',
    'session/turn',
    'mount:session-send',
    'mount:session-answer',
    'mount:session-signal',
  ],
  'session-resume': [
    'session/resume',
    'session/restart',
    'session/auto-resume',
    'mount:session-resume',
    'mount:session-restart',
  ],
  'session-reads': [
    'session/reads',
    'session/transcript',
    'transcript',
    'session/hypermedia',
    'session/attach',
    'session/snapshot',
    'session/observer',
    'session/monitor',
    'session/live',
    'session/events',
    'session/context',
    'session/compact-at',
    'mount:session-reads',
    'mount:session-hypermedia',
    'mount:session-attach',
    'mount:session-compact-at',
    'mount:sessions',
  ],
  // Everything else under session/ (launch, lifecycle, harness, directory, health, effects, processes, permission,
  // dialog, filesystem, provenance, runtime-control, reap, conversation-lease) is the session core.
  sessions: [
    'session',
    'mount:session-control',
    'mount:session-rename',
    'mount:session-runtime',
    'mount:session-credential',
    'mount:session-dialog',
    'mount:session-permission',
    'mount:session-processes',
    'mount:session-filesystem',
    'mount:system-session-control',
  ],
};

const KEY_TO_MODULE = new Map<string, string>();
for (const [module, keys] of Object.entries(MODULES)) for (const key of keys) KEY_TO_MODULE.set(key, module);

/** The feature key of a repository path, or undefined when the path is not daemon feature code. */
export function featureKey(path: string): string | undefined {
  const mount = path.match(
    /^packages\/daemon\/(?:src\/lib\/runtime\/mounts|tests\/(?:unit|integration)\/runtime\/mounts)\/([^/.]+)/,
  );
  if (mount) return `mount:${mount[1]}`;
  const session = path.match(
    /^packages\/daemon\/(?:src\/(?:lib|adapters)|tests\/(?:unit|integration))\/session\/([^/.]+)/,
  );
  if (session) return `session/${session[1]}`;
  const dir = path.match(/^packages\/daemon\/(?:src\/(?:lib|adapters)|tests\/(?:unit|integration))\/([^/.]+)\//);
  if (dir) return dir[1];
  if (/^packages\/daemon\/(?:src\/(?:lib|adapters)|tests\/(?:unit|integration))\/[^/]+\.ts$/.test(path))
    return '(root)';
  return undefined;
}

export function moduleOfKey(key: string): string {
  const known = KEY_TO_MODULE.get(key);
  if (known !== undefined) return known;
  if (key.startsWith('session/')) return 'sessions';
  if (key.startsWith('mount:session-')) return 'sessions';
  return `?${key}`;
}

export function moduleOfPath(path: string): string | undefined {
  const key = featureKey(path);
  return key === undefined ? undefined : moduleOfKey(key);
}
