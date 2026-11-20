/**
 * A fake machine for the import pages, written out longhand and parsed through the real schema (a wire change fails here
 * first). Every name and address is made up; the scan carries names only, never a value.
 */
import { type SetupScan, SetupScanSchema } from '@ferretry/plugin-runtimes/contract';

export const CHANGE_ID = 'fy_fprop_abcdefghijklmnopqrstuv';
export const SENTENCES =
  'Runtimes: claude-code-default. Written by the parts that own them: mcp/notes.yaml, skills/review.yaml. Not written: mcp/issues.yaml (a secret-shaped value).';

export interface Found {
  readonly installed?: boolean;
  readonly instructions?: boolean;
  readonly settings?: boolean;
  readonly mcp?: readonly string[];
  readonly skills?: readonly string[];
  readonly secrets?: readonly string[];
  readonly duplicates?: SetupScan['duplicates'];
}

export const scanOf = ({
  installed = true,
  instructions = true,
  settings = true,
  mcp = ['notes', 'issues'],
  skills = ['review', 'release-notes'],
  secrets = ['env.ANTHROPIC_API_KEY'],
  duplicates = [],
}: Found = {}): SetupScan =>
  SetupScanSchema.parse({
    machine: 'studio-mac',
    format: 'none',
    tools: [
      installed
        ? { harness: 'claude-code', label: 'Claude Code', installed: true }
        : {
            harness: 'claude-code',
            label: 'Claude Code',
            installed: false,
            install: { kind: 'runnable', command: 'npm install --global @fake/claude-code' },
          },
    ],
    harnesses: [
      {
        harness: 'claude-code',
        installed,
        account: { state: 'signed-in', email: 'sam@example.test' },
        ...(instructions ? { instructions: { name: 'CLAUDE.md', source: '~/.claude/CLAUDE.md', bytes: 2_048 } } : {}),
        ...(settings ? { settings: { source: '~/.claude/settings.json', count: 7, hooks: 3 } } : {}),
        mcpServers: mcp,
        skills,
        secretKeys: secrets,
        missingCommands: [],
        problems: [],
      },
    ],
    runtimes: [{ harness: 'claude-code', name: 'claude-code-default', profile: 'Default' }],
    updates: [],
    duplicates,
    notes: [],
    importing: { available: true },
  });

/** The routes a Claude import page reads and writes on a fake machine. */
export const importRoutes = (scan: SetupScan): Record<string, unknown> => ({
  'GET /v1/runtimes/setup/scan': scan,
  'GET /v1/claude-code/update': { installed: { state: 'ok', version: '2.1.0' } },
  'GET /v1/codex/update': { installed: null },
  'GET /v1/runtimes/machine': {
    name: 'studio-mac',
    format: 'present',
    setUp: true,
    agentPermissions: 'auto',
    defaultRuntime: 'claude-default',
    agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
    browserMode: 'headless',
    browserProxy: null,
    browserPorts: 'random',
    browserFirewallFailure: 'warn',
    autoResume: true,
    agendaMode: false,
    publicUsageFeed: false,
    lastAutoResume: null,
    tools: [{ harness: 'claude-code', label: 'Claude Code', installed: true, command: '/fake/bin/claude' }],
    runtimeCount: 1,
    runningSessions: 0,
    authority: { mayApply: true, applyRefusal: 'granted' },
  },
  'POST /v1/runtimes/proposals': (call: { readonly body?: unknown } = {}) => ({
    id: CHANGE_ID,
    revision: 'r1',
    change: (call.body as { change: unknown }).change,
    summary: 'A change',
    consequences: [],
    expiresAt: '2026-10-13T08:15:00.000Z',
    state: 'pending',
    preview: { kind: 'executor', executor: 'setup', description: 'Import.' },
  }),
  'POST /v1/runtimes/proposals/:proposalId/apply': { outcome: 'executed', executor: 'setup', summary: SENTENCES },
});
