/**
 * The browser entry for the import wizard: the REAL step body over ONE FAKE machine that answers from memory. No daemon, no
 * network. Every name below is made up.
 *
 *   ?view=fresh      nothing installed: both tools offer their install command
 *   ?view=claude     Claude Code found everything (instructions, MCP, skills, settings, secret env, hooks, project folders)
 *   ?view=codex-off  Claude Code installed and brought in; Codex not installed (open on the Codex tab)
 *   ?view=secrets    only a secret-looking environment to bring
 *   ?view=hooks      hooks and project instructions present (the greyed lines)
 *   ?view=signin     installed, not signed in
 *   ?theme=<family>-<mode>
 */
import { createRoot } from 'react-dom/client';
import { ImportStep } from '../../../../app/features/import-wizard/import-step.tsx';
import type { SetupScan } from '../../../../contract/index.ts';
import {
  type Call,
  CHANGE_ID,
  machine,
  scripted,
  stagedFrom,
} from '../../../unit/app/features/fleet/account-support.ts';
import { CLAUDE_FULL, CODEX_FULL, scanOf, UPDATE_OK } from '../../../unit/app/features/import-wizard/scans.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const view = params.get('view') ?? 'claude';

const scans: Readonly<Record<string, SetupScan>> = {
  fresh: scanOf({ claude: 'absent', codex: 'absent' }),
  claude: scanOf({ claude: CLAUDE_FULL, codex: CODEX_FULL }),
  'codex-off': scanOf({ claude: CLAUDE_FULL, codex: 'absent' }),
  secrets: scanOf({
    claude: { secretKeys: ['env.ANTHROPIC_API_KEY', 'env.GITHUB_TOKEN', 'env.NOTES_TOKEN'] },
    codex: 'absent',
  }),
  hooks: scanOf({
    claude: {
      instructions: CLAUDE_FULL.instructions,
      settings: { source: '~/.claude/settings.json', count: 12, hooks: 5 },
      projectInstructions: CLAUDE_FULL.projectInstructions ?? [],
    },
    codex: 'absent',
  }),
  signin: scanOf({ claude: { ...CLAUDE_FULL, account: { state: 'not-signed-in' } }, codex: 'absent' }),
};

const client = scripted({
  'GET /v1/runtimes/setup/scan': scans[view] ?? scans['claude'],
  'GET /v1/claude-code/update': UPDATE_OK('2.1.0'),
  'GET /v1/codex/update': UPDATE_OK('0.9.0'),
  'GET /v1/runtimes/machine': machine(),
  'POST /v1/runtimes/proposals': (call: Call) => ({
    ...stagedFrom(call),
    preview: { kind: 'executor', executor: 'setup', description: 'Import.' },
  }),
  [`POST /v1/runtimes/proposals/${CHANGE_ID}/apply`]: {
    outcome: 'executed',
    executor: 'setup',
    summary:
      'Runtimes: claude-code-default. Written by the parts that own them: mcp/notes.yaml, mcp/issues.yaml, skills/review.yaml, claude-code/settings/default.yaml. Not written: skills/release-notes.yaml (a name it does not accept).',
  },
  'POST /v1/onboarding/steps/:plugin/:stepId': { ok: true },
});

const root = document.getElementById('root') as HTMLElement;
root.className = 'mx-auto max-w-[640px] p-4';
createRoot(root).render(<ImportStep client={client} machineName="studio-mac" />);
