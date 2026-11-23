/**
 * A fake machine's first-run scan for the AI picker's "Found on this computer" chip: Claude Code installed here with a setup to
 * bring over, or not installed. Written longhand and parsed through the real wire schema (a wire change fails here first). Every
 * name is made up; the scan carries names only, never a value.
 */
import { type SetupScan, SetupScanSchema } from '@ferretry/plugin-runtimes/contract';

export const hostScan = (claudeInstalled: boolean): SetupScan =>
  SetupScanSchema.parse({
    machine: 'studio-mac',
    format: 'none',
    tools: [
      claudeInstalled
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
        installed: claudeInstalled,
        account: { state: 'signed-in', email: 'sam@example.test' },
        instructions: { name: 'CLAUDE.md', source: '~/.claude/CLAUDE.md', bytes: 2_048 },
        settings: { source: '~/.claude/settings.json', count: 7, hooks: 3 },
        mcpServers: ['notes'],
        skills: ['review'],
        secretKeys: [],
        missingCommands: [],
        problems: [],
      },
    ],
    runtimes: [],
    updates: [],
    duplicates: [],
    notes: [],
    importing: { available: true },
  });
