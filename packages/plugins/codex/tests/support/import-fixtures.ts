/**
 * Fake machine answers for the Codex import pages' suites and shots: a scan written out longhand and parsed through the real
 * schema (a wire change fails here first), the machine view, and the staged change. Every name, path and e-mail is made up; the scan
 * carries names only, never a value.
 */
import { type HarnessScan, type SetupScan, SetupScanSchema } from '@ferretry/plugin-runtimes/contract';

export const CHANGE_ID = 'fy_fprop_abcdefghijklmnopqrstuv';

export const CODEX_FULL: Partial<HarnessScan> = {
  instructions: { name: 'AGENTS.md', source: '/fake/home/.codex/AGENTS.md', bytes: 900 },
  settings: { source: '/fake/home/.codex/config.toml', count: 4, hooks: 1 },
  mcpServers: ['notes', 'search'],
  skills: ['review', 'deploy'],
  codexProfiles: [
    { name: 'fast', model: 'gpt-fast', effort: 'low' },
    { name: 'deep', model: 'gpt-deep', effort: 'high' },
  ],
  secretKeys: ['env.NOTES_KEY', 'env.GH_TOKEN'],
};

export const scanOf = (
  codex: Partial<HarnessScan> | 'absent',
  options: { readonly duplicate?: string; readonly updates?: SetupScan['updates'] } = {},
): SetupScan => {
  const found =
    codex === 'absent'
      ? []
      : [
          {
            harness: 'codex' as const,
            installed: true,
            account: { state: 'signed-in' as const, email: 'sam@example.test' },
            mcpServers: [],
            skills: [],
            secretKeys: [],
            missingCommands: [],
            problems: [],
            ...codex,
          },
        ];
  return SetupScanSchema.parse({
    machine: 'studio-mac',
    format: 'none',
    tools: [
      { harness: 'claude-code', label: 'Claude Code', installed: true },
      codex === 'absent'
        ? {
            harness: 'codex',
            label: 'Codex',
            installed: false,
            install: { kind: 'runnable', command: 'npm i -g @fake/codex' },
          }
        : { harness: 'codex', label: 'Codex', installed: true },
    ],
    harnesses: found,
    runtimes: found.map(entry => ({ harness: entry.harness, name: 'codex-default', profile: 'Default' })),
    updates: options.updates ?? [],
    duplicates:
      options.duplicate === undefined ? [] : [{ harness: 'codex', existing: options.duplicate, suggested: 'codex-2' }],
    notes: [],
    importing: { available: true },
  });
};

export const MACHINE = {
  name: 'studio-mac',
  format: 'present',
  setUp: true,
  agentPermissions: 'auto',
  defaultRuntime: 'codex-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  browserMode: 'headless',
  browserProxy: null,
  browserPorts: 'random',
  browserFirewallFailure: 'warn',
  autoResume: true,
  agendaMode: false,
  publicUsageFeed: false,
  lastAutoResume: null,
  tools: [
    { harness: 'claude-code', label: 'Claude Code', installed: true, command: '/fake/bin/claude' },
    { harness: 'codex', label: 'Codex', installed: true, command: '/fake/bin/codex' },
  ],
  runtimeCount: 1,
  runningSessions: 0,
  authority: { mayApply: true, applyRefusal: 'granted' },
};

/** The daemon's staged answer for whatever change was sent (what `stagedFrom` is in Runtimes' own suites). */
export const stagedFrom = (call: { readonly body?: unknown }) => ({
  id: CHANGE_ID,
  revision: 'r1',
  change: (call.body as { change: unknown }).change,
  summary: 'A change',
  consequences: [],
  expiresAt: '2026-10-13T08:15:00.000Z',
  state: 'pending',
  preview: { kind: 'executor', executor: 'setup', description: 'Import.' },
});

export const APPLIED_SENTENCES =
  'Runtimes: codex-default. Written by the parts that own them: mcp/notes.yaml, skills/review.yaml. Not written: mcp/search.yaml (a secret-shaped value).';
