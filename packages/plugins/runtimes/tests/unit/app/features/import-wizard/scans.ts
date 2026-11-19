/**
 * Fake scans for the import wizard's suites and shots: a machine written out longhand and parsed through the real schema, so a
 * wire change fails here first. Every name and e-mail is made up; the scan carries names only, never a value.
 */
import { type HarnessScan, type SetupScan, SetupScanSchema } from '../../../../../contract/index.ts';

type Scan = {
  readonly claude?: Partial<HarnessScan> | 'absent';
  readonly codex?: Partial<HarnessScan> | 'absent';
  readonly duplicates?: SetupScan['duplicates'];
};

const base = (harness: 'claude-code' | 'codex'): HarnessScan => ({
  harness,
  installed: true,
  account: { state: 'signed-in', email: harness === 'codex' ? 'sam@example.test' : 'sam@example.test' },
  mcpServers: [],
  skills: [],
  secretKeys: [],
  missingCommands: [],
  problems: [],
});

export const CLAUDE_FULL: Partial<HarnessScan> = {
  instructions: { name: 'CLAUDE.md', source: '~/.claude/CLAUDE.md', bytes: 2_048 },
  settings: { source: '~/.claude/settings.json', count: 7, hooks: 3 },
  mcpServers: ['notes', 'issues'],
  skills: ['review', 'release-notes'],
  secretKeys: ['env.ANTHROPIC_API_KEY', 'env.NOTES_TOKEN'],
  projectInstructions: [
    { path: '/home/sam/work/api', file: 'CLAUDE.md', verified: false },
    { path: '/home/sam/work/web', file: 'CLAUDE.md', verified: false },
  ],
};

export const CODEX_FULL: Partial<HarnessScan> = {
  instructions: { name: 'AGENTS.md', source: '~/.codex/AGENTS.md', bytes: 900 },
  settings: { source: '~/.codex/config.toml', count: 4, hooks: 0 },
  mcpServers: ['notes'],
  skills: ['review'],
  codexProfiles: [
    { name: 'fast', model: 'gpt-fast', effort: 'low' },
    { name: 'deep', model: 'gpt-deep', effort: 'high' },
  ],
};

export const scanOf = ({ claude = {}, codex = {}, duplicates = [] }: Scan = {}): SetupScan => {
  const harnesses = [
    ...(claude === 'absent' ? [] : [{ ...base('claude-code'), ...claude }]),
    ...(codex === 'absent' ? [] : [{ ...base('codex'), ...codex }]),
  ];
  const tool = (harness: 'claude-code' | 'codex', label: string) => {
    const found = harnesses.find(entry => entry.harness === harness);
    return found?.installed === false || found === undefined
      ? {
          harness,
          label,
          installed: false as const,
          install: {
            kind: 'runnable' as const,
            command: harness === 'codex' ? 'npm i -g @openai/codex' : 'brew install --cask claude-code',
          },
        }
      : { harness, label, installed: true as const };
  };
  return SetupScanSchema.parse({
    machine: 'studio-mac',
    format: 'none',
    tools: [tool('claude-code', 'Claude Code'), tool('codex', 'Codex')],
    harnesses,
    runtimes: harnesses
      .filter(entry => entry.installed)
      .map(entry => ({ harness: entry.harness, name: `${entry.harness}-default`, profile: 'Default' })),
    updates: [],
    duplicates,
    notes: [],
    importing: { available: true },
  });
};

export const UPDATE_OK = (version: string) => ({ installed: { state: 'ok', version } });
