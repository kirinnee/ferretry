/**
 * The browser entry for the import wizard: the REAL step body over ONE FAKE machine that answers from memory. No daemon, no
 * network. Every name below is made up.
 *
 *   ?view=fresh      nothing installed: both tools offer their install command
 *   ?view=claude     Claude Code found everything (instructions, MCP, skills, settings, secret env, hooks, project folders)
 *   ?view=codex-off  Claude Code installed and brought in; Codex not installed (open on the Codex tab)
 *   ?view=secrets    only a secret-looking environment to bring
 *   ?view=hooks      hooks and project instructions present (the greyed lines)
 *   ?view=confirm    the machine wants a passkey before it shows the setup (a quiet read is refused, nothing prompts)
 *   ?view=changed    a re-import: CLAUDE.md and a skill changed since the last time (ticked by default)
 *   ?view=signin     installed, not signed in
 *   ?view=retry      a retry on an import that already made its runtime: no new name is asked for
 *   ?view=timeout    Claude Code found everything; the import never answers, and what the machine then says landed is listed
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
  changed: {
    ...scanOf({ claude: CLAUDE_FULL, codex: 'absent' }),
    updates: [
      { reference: 'instructions/claude', sources: ['~/.claude/CLAUDE.md'] },
      { reference: 'skills/review', sources: ['~/.claude/skills/review'] },
    ],
  },
  retry: scanOf({
    claude: CLAUDE_FULL,
    codex: 'absent',
    duplicates: [{ harness: 'claude-code', existing: 'claude-default', suggested: 'claude-default-2' }],
  }),
  signin: scanOf({ claude: { ...CLAUDE_FULL, account: { state: 'not-signed-in' } }, codex: 'absent' }),
};

const client = scripted({
  'GET /v1/runtimes/setup/scan': (call: Call) =>
    view === 'confirm' && call.quiet === true
      ? { code: 'grant_step_up_required', message: 'confirm with your passkey' }
      : (scans[view] ?? scans['claude']),
  'GET /v1/claude-code/update': UPDATE_OK('2.1.0'),
  'GET /v1/codex/update': UPDATE_OK('0.9.0'),
  'GET /v1/runtimes/machine': machine(),
  'POST /v1/runtimes/proposals': (call: Call) => ({
    ...stagedFrom(call),
    preview: { kind: 'executor', executor: 'setup', description: 'Import.' },
  }),
  // `?view=timeout`: the apply never answers (the page gives up at its short deadline), and the machine, asked once, says
  // the change stopped part-way: the two lists the daemon keeps for it (names only, made up).
  [`POST /v1/runtimes/proposals/${CHANGE_ID}/apply`]:
    view === 'timeout'
      ? () => new Promise(() => undefined)
      : {
          outcome: 'executed',
          executor: 'setup',
          summary:
            '1 runtime created on Studio: Claude · your terminal sign-in. Saved: your MCP servers, your Claude skills. Not written: your Claude settings (a name it does not accept).',
        },
  [`GET /v1/runtimes/proposals/${CHANGE_ID}`]: Object.assign(
    new Error(
      `fleet proposal "${CHANGE_ID}" was only partly applied. Part of this change was applied: secret-store key ANTHROPIC_API_KEY, login claude-default, claude-code/settings/default.yaml. The rest was not: skills/review.yaml, the runtimes and fleet files, variables of login claude-default. Review the change again to finish it.`,
    ),
    {
      status: 409,
      code: 'fleet_change_consumed',
      body: {
        error: 'was only partly applied',
        code: 'fleet_change_consumed',
        landed: ['secret-store key ANTHROPIC_API_KEY', 'login claude-default', 'claude-code/settings/default.yaml'],
        notLanded: ['skills/review.yaml', 'the runtimes and fleet files', 'variables of login claude-default'],
      },
    },
  ),
  'POST /v1/onboarding/steps/:plugin/:stepId': { ok: true },
});

const root = document.getElementById('root') as HTMLElement;
root.className = 'mx-auto max-w-[640px] p-4';
createRoot(root).render(
  <ImportStep
    client={client}
    machineName="studio-mac"
    {...(view === 'timeout' ? { applyOptions: { deadlineMs: 1_000 } } : {})}
  />,
);
