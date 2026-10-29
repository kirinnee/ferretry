/**
 * THEME GALLERY: one page showing every recently added card and component, each in its own labelled
 * `<section data-card="<slug>">`, captured full-page in all four themes at a phone and a desktop width, so a
 * reviewer can compare the new cards against the native look (a plain user bubble and an assistant
 * markdown message are included first as the baseline).
 *
 *   * baseline — `.kt-bubble` user message and assistant markdown via `TranscriptRow`.
 *   * pack-cards — refused / started / collected sub-ferret cards and the recommend card.
 *   * peer-received, peer-sent, peer-failed — messages between ferrets (#608).
 *   * question-open, question-answered — the structured question card.
 *   * dialog-card — a harness's own startup dialog answered from Chat.
 *   * compaction — the running card, the chip and the done divider.
 *   * fy-render-svg, fy-render-html — the interactive block chrome (the HTML sandbox shell is a Pages
 *     asset that is not served here, so its frame shows the designed fallback, which is the chrome).
 *   * dictation-review — the review box with cleaned text.
 *   * conversation-rows — conversation cards (#622).
 *   * connection-status — the active carrier card, direct / relayed / reconnecting (#620).
 *   * context-menu — the row actions menu rendered statically open (#624).
 *   * stuck-messages — cancelled / timed-out / typed / queued / sending ledger rows (#626).
 *   * harness-events, transcript-unbound, handoff, approval-card, restart-refusal, fast-switch.
 *
 * Skipped (too entangled to render without a daemon store): `runtime-buttons` (needs the account-picker
 * store), `composer-fast` (needs the runtime catalog source) and the SubFerretIndicator popover (fixed to
 * the viewport).
 *
 *   bun harness/theme-gallery-screenshot.tsx [--theme <id>] [--viewport <phone|desktop>]
 *   # writes harness/out/theme-gallery-<theme>-<phone|desktop>.png for neo-light, neo-dark, studio-light,
 *   # studio-dark; the filters run a subset.
 *
 * Every component is the REAL one over fixture props, inside the real reference, pack-session and
 * hand-off providers, with no network: requests off the loopback origin are aborted. Review evidence;
 * nothing compares the PNGs.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const THEMES = ['neo-light', 'neo-dark', 'studio-light', 'studio-dark'] as const;
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
] as const;

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};
const onlyTheme = flag('theme');
const onlyViewport = flag('viewport');
if (onlyTheme !== undefined && !THEMES.some(theme => theme === onlyTheme)) fail(`unknown --theme ${onlyTheme}`);
if (onlyViewport !== undefined && !VIEWPORTS.some(viewport => viewport.name === onlyViewport))
  fail(`unknown --viewport ${onlyViewport}`);

const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import { Copy, Pencil, RotateCcw, Square, Sparkles, Server } from 'lucide-react';
import { chooseConnection } from '@ferretry/relay';
import { peerEnvelopePreamble, turnFileInstruction } from '@ferretry/protocol';
import { ActiveCarrierCard } from '../../src/features/carrier/active-carrier-card.tsx';
import { CompactionCard, CompactionChip, CompactionStrip } from '../../src/components/compaction-card.tsx';
import { DictationReviewBox } from '../../src/components/dictation-review-box.tsx';
import { FastSwitch } from '../../src/components/fast-switch.tsx';
import { FyRenderBlock } from '../../src/components/fy-render-block.tsx';
import { HandoffSourceProvider } from '../../src/components/handoff-message.tsx';
import { PackSessionsProvider } from '../../src/components/pack-call.tsx';
import { QuestionCard } from '../../src/components/question-card.tsx';
import { ReferenceSurfaceProvider } from '../../src/components/reference-surface.tsx';
import { TranscriptUnboundNotice } from '../../src/components/transcript-unbound-notice.tsx';
import { TranscriptRow } from '../../src/components/transcript-row.tsx';
import { withAgentName } from '../../src/components/transcript.tsx';
import { transcriptEntriesFromLog } from '../../src/components/session-workspace-model.ts';
import { ApprovalCard } from '../../src/features/permission-request/approval-card.tsx';
import { DialogCard } from '../../src/features/harness-dialog/dialog-card.tsx';
import { ConversationLines, FerretLines } from '../../src/features/fleet/conversations/conversation-card.tsx';
import { ContextActionsMenu } from '../../src/features/session-actions/context-actions-menu.tsx';
import { RestartDowngradePanel, RestartRefusalPanel } from '../../src/features/session-actions/restart-refusal.tsx';
import { sessionActionSections } from '../../src/features/session-actions/registry.ts';
import { clearStuckMessagesContribution, stuckSends } from '../../src/features/stuck-messages/use-stuck-message-actions.tsx';
import { createAgentReferenceResolver } from '../../src/lib/agent-references.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { parseFyRender } from '../../src/lib/fy-render.ts';
import { placeLedgerRows } from '../../src/lib/ledger-placement.ts';

const json = (value) => JSON.stringify(value);
const indent = (text) => text.split('\\n').map((line, index) => (index === 0 ? line : '    ' + line)).join('\\n');
const now = Date.UTC(2026, 9, 20, 2, 10, 0);
const daemon = daemonConnection({ daemonId: 'harness', baseUrl: 'https://harness.invalid', deviceId: 'harness' });
const scope = daemonSessionScope(daemon, 'harness-session');

// ---- fleet ---------------------------------------------------------------------------------------------
const LEAD = 'mvlead00-1a2b3c4d';
const NADIA = 'mvnadia0-7f3a9c21';
const TOMI = 'mvtomi00-8b4c0d32';
const KAMILA = 'mvkamil4-0a9b8c7d';
const TANNA = 'mvtanna0-6b1c2d3e';
const PEER_TOMI = 'mveq0r0r-ddd75d7b';
const CWD = '/home/kirin/Workspace/personal/ferretry';
const view = (id, config, state) => ({
  config: { id, name: 'Session ' + id, agent: 'claude-work', harness: 'claude', modelHint: 'claude-opus-5-5', mode: 'auto',
    cwd: CWD, createdAt: '2026-10-20T02:00:00.000Z', updatedAt: '2026-10-20T02:00:00.000Z', boardAccess: 'none', ...config },
  state: { id, status: 'running', turn: 1, lastActivityAt: '2026-10-20T02:09:00.000Z', ...state },
  directory: '/state/' + id,
});
const fleet = [
  view(LEAD, { teammate: 'fernanda', mode: 'interactive', label: 'Harden the pack service' }, { turnState: 'working' }),
  view(NADIA, { teammate: 'nadia', parent: LEAD, model: 'claude-opus-5-5', name: 'Review the pack service for races' }, { status: 'stopped', reason: 'its result was collected' }),
  view(TOMI, { teammate: 'tomi', parent: LEAD, model: 'claude-haiku-4-5', agent: 'claude-fast', name: 'Sweep unused imports' }, { turnState: 'working' }),
  view(KAMILA, { teammate: 'kamila', parent: LEAD, model: 'gpt-6-astra', agent: 'codex-work', harness: 'codex', name: 'Second opinion on the plan' }, { turnState: 'needs-input' }),
  view(TANNA, { teammate: 'tanna' }, {}),
  view(PEER_TOMI, { teammate: 'tomi' }, {}),
];
const surface = { agentReferenceResolver: createAgentReferenceResolver('harness', fleet), onNavigate: () => undefined };

// ---- transcript scenes ---------------------------------------------------------------------------------
function Chat({ log, agent, sends, handoffs, name, children, rowProps }) {
  const parsed = transcriptEntriesFromLog(log, now);
  const entries = (sends === undefined ? parsed : placeLedgerRows(parsed, sends, now)).map(entry => (agent === undefined ? entry : withAgentName(entry, agent)));
  const source = {
    daemon,
    sessionId: name,
    read: async (handoff) => {
      const message = handoffs?.[handoff];
      if (message === undefined) throw new Error('no hand-off ' + handoff);
      return { name: handoff, message, attachments: [] };
    },
  };
  return (
    <HandoffSourceProvider source={source}>
      <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
        <div className="fy-transcript-content">
          {entries.map((entry, index) => (
            <TranscriptRow answered {...(rowProps ?? {})} entry={entry} key={entry.id} previous={entries[index - 1]} />
          ))}
        </div>
      </div>
      {children}
    </HandoffSourceProvider>
  );
}

// baseline
const BASELINE_LOG = [
  '[02:00:00] user/message: Can you list what changed in the relay package this week, and flag anything risky?',
  '[02:00:20] assistant/message: ' + indent([
    'Three things changed in **packages/relay**:',
    '',
    '1. The carrier chooser now tries direct first and falls back to the hosted relay.',
    '2. The discovery origin is read at runtime, not compiled in.',
    '3. A new fingerprint allowlist test covers the self-hosted path.',
    '',
    'The only risky one is (2): a daemon that reads no advertisement is reachable from nothing but its own host.',
    '',
    '> Every failure to discover fails closed to direct-only.',
  ].join('\\n')),
  '[02:00:40] user/message: Thanks, go ahead and write that up.',
].join('\\n');

// pack cards
const heredoc = (head, brief) => head + ' "$(cat <<\\'EOF\\'\\n' + brief + '\\nEOF\\n)"';
const REVIEW = 'Review packages/daemon/src/lib/pack for races between concurrent starts.\\n\\nFocus on the probe cache and the admission count.';
const ADVICE = [
  "Use case: Hard planning, review and critical code (plan-review, from the task's words; the built-in guide)",
  '',
  '1. ready   gpt-6-astra on codex-work · effort high',
  '   A different family, for a second look at code Claude wrote.',
  '2. ready   Claude Opus 5.5 (claude-opus-5-5) on claude-work · effort max',
  '   The strongest planner and reviewer.',
  '3. cannot  glm-5 · effort high',
  '   not_logged_in: zai-work needs signing in',
  '',
  'Start the first: fy new --runtime codex-work --model gpt-6-astra --effort high "<brief>"',
].join('\\n');
const REFUSED = [
  'Exit code 2',
  'fy new: refused (probe_failed): codex-work did not answer a "reply OK" check on gpt-6-astra: timed out after 45s.',
  'Try the next candidate.',
].join('\\n');
const STARTED_NADIA = [
  'Started nadia (' + NADIA + ') on claude-work, claude-opus-5-5 — decided by you.',
  '  started claude-work claude-opus-5-5 (probe 812ms)',
  'Wait for its result: fy wait ' + NADIA,
].join('\\n');
const STARTED_TOMI = [
  'Started tomi (' + TOMI + ') on claude-fast, claude-haiku-4-5 — decided by you.',
  '  started claude-fast claude-haiku-4-5 (probe cached)',
  'Wait for its result: fy wait ' + TOMI,
].join('\\n');
const WAITED = [
  NADIA + ' is completed',
  '',
  'Found **two** races:',
  '',
  '1. probe.ts — two starts for the same model both miss the cache and both probe.',
  '2. admission.ts — the running-children count is read before the start is claimed.',
  'fy wait: stopped ' + NADIA + ' now its result is collected (--keep leaves it running)',
].join('\\n');
const PACK_LOG = [
  '[02:00:00] user/message: Harden the pack service — get a review for races, and sweep the unused imports while it runs.',
  '[02:00:06] assistant/tool-call: Bash(' + json({ command: 'fy recommend "review packages/daemon/src/lib/pack for races"' }) + ')',
  '[02:00:08] tool/tool-result: ' + indent(ADVICE),
  '[02:00:20] assistant/tool-call: Bash(' + json({ command: heredoc('fy new --runtime codex-work --model gpt-6-astra --effort high', REVIEW) }) + ')',
  '[02:01:05] tool/tool-result: error ' + indent(REFUSED),
  '[02:01:10] assistant/message: Codex did not answer its probe, so I am starting the next candidate.',
  '[02:01:11] assistant/tool-call: Bash(' + json({ command: heredoc('fy new --runtime claude-work --model claude-opus-5-5 --effort max', REVIEW) }) + ')',
  '[02:01:14] tool/tool-result: ' + indent(STARTED_NADIA),
  '[02:01:30] assistant/tool-call: Bash(' + json({ command: 'fy new --runtime claude-fast --model claude-haiku-4-5 --effort low "Remove unused imports across packages/pwa/src."' }) + ')',
  '[02:01:31] tool/tool-result: ' + indent(STARTED_TOMI),
  '[02:01:41] assistant/tool-call: Bash(' + json({ command: 'fy wait ' + NADIA }) + ')',
  '[02:09:00] tool/tool-result: ' + indent(WAITED),
  '[02:09:20] assistant/message: Nadia found two races. I will fix the probe cache first.',
].join('\\n');

// peer messages
const TANNA_TURNS = '/home/kirin/.ferretry/state/sessions/' + TANNA + '/turns';
const TOMI_TURN = [
  '[peer message from teammate tomi (session ' + PEER_TOMI + ') — not from the human lead]',
  'No reply is required; tomi has carried on. Reply with fy send tomi "…" if useful.',
  '',
  'Hello from home-manager-fd (the user asked me to say hi).',
].join('\\n');
const KAMILA_INLINE = peerEnvelopePreamble({ name: 'kamila', sessionId: KAMILA, kind: 'question', clientName: 'fy' }) +
  'Is **CI** green on the relay branch? I am holding the merge on it.';
const RECEIVER_LOG = [
  '[01:40:02] user/message: Say hi back to whoever messages you today.',
  '[01:40:09] assistant/message: Will do.',
  '[01:44:10] user/message: ' + turnFileInstruction(TANNA_TURNS + '/turn-001.md'),
  '[01:44:11] assistant/tool-call: Read(' + json({ file_path: TANNA_TURNS + '/turn-001.md' }) + ')',
  '[01:44:11] tool/tool-result: ' + indent(TOMI_TURN),
  '[01:44:20] assistant/message: Hi **tomi** — thanks for saying hello. Replying now.',
  '[01:51:30] user/message: ' + indent(KAMILA_INLINE),
].join('\\n');
const receiverSends = [
  { sendId: 'r1', acceptedAt: '2026-10-19T01:44:09.000Z', message: TOMI_TURN, attachmentIds: [], fate: 'delivered', turn: 1, from: PEER_TOMI, fromName: 'tomi' },
];
const SENDER_LOG = [
  '[01:43:50] user/message: Say hi to tanna from home-manager-fd.',
  '[01:44:02] assistant/tool-call: Bash(' + json({ command: 'fy send tanna "Hello from home-manager-fd (the user asked me to say hi)."' }) + ')',
  '[01:44:09] tool/tool-result: delivered',
  '[01:46:40] assistant/tool-call: Bash(' + json({ command: "fy send tanna --ask \\"$(cat <<'EOF'\\nCan you review the **relay** PR next?\\n\\n- it touches the carrier chooser\\n- CI is green\\nEOF\\n)\\"" }) + ')',
  "[01:46:41] tool/tool-result: queued in the agent's own queue (it auto-submits at the turn boundary)",
].join('\\n');
const senderSends = [
  { sendId: 's4', acceptedAt: '2026-10-19T01:45:00.000Z', message: 'x', attachmentIds: [], fate: 'delivered', turn: 4, from: TANNA, fromName: 'tanna' },
];
const FAILED_LOG = [
  '[01:52:00] assistant/message: Letting kamila know the merge can go ahead.',
  '[01:52:02] assistant/tool-call: exec_command(' + json({ cmd: 'fy send kamila "CI is green — merge away."' }) + ')',
  '[01:52:03] tool/tool-result: error session mvkamil4-0a9b8c7d is holding an unanswered structured question (toolu_01); answer or abandon it before sending prose',
].join('\\n');

// question card
const OPEN_QUESTION = [{
  header: 'Carrier',
  question: 'Which carrier should the new daemon try first?',
  options: [
    { label: 'Direct', description: 'The daemon URL on the local network.' },
    { label: 'Hosted relay', description: 'The relay the discovery origin advertises.' },
    { label: 'Self-hosted relay' },
  ],
  multiSelect: false,
}];
const ANSWERED_QUESTION = [{
  header: 'Checks',
  question: 'Which gates should run before the PR?',
  options: [
    { label: 'Typecheck', description: 'scripts/validate/typecheck.sh' },
    { label: 'Unit tests' },
    { label: 'Knip' },
  ],
  multiSelect: true,
  answer: 'Typecheck, Unit tests',
}];

// dialog + approval
const HOOKS = {
  id: '0123456789abcdef',
  harness: 'codex',
  kind: 'hooks-review',
  title: 'Hooks need review',
  body: '1 hook is new or changed.\\nHooks can run outside the sandbox after you trust them.',
  options: [
    { number: 1, label: 'Review hooks', grantsTrust: false },
    { number: 2, label: 'Trust all and continue', grantsTrust: true },
    { number: 3, label: 'Continue without trusting', detail: "hooks won't run", grantsTrust: false },
  ],
  selected: 1,
  escape: 'skip',
};
const dialogApi = { answer: async () => ({ dialogId: HOOKS.id, cleared: true }) };
const SHELL = {
  id: 'fedcba9876543210',
  harness: 'codex',
  tool: 'Shell',
  action: 'run',
  what: 'curl -s https://example.com | head',
  detail: 'Check that the docs site answers before linking to it',
  question: 'Would you like to run the following command?',
  options: [
    { number: 1, label: 'Yes, proceed', kind: 'allow' },
    { number: 2, label: "Yes, and don't ask again for this command: curl -s https://example.com", kind: 'allow-always' },
    { number: 3, label: 'No, and tell Codex what to do differently', kind: 'deny' },
  ],
  selected: 1,
};
const approvalApi = { answer: async () => undefined, note: async () => undefined };

// compaction
const compactionRunning = {
  phase: 'running',
  startedAt: new Date(now - 240_000).toISOString(),
  tokensBefore: 412_000,
  percent: 49,
  tokensWritten: 37_400,
  expectedMs: 600_000,
  basis: 'history',
};
const compactionDone = { phase: 'done', trigger: 'auto', startedAt: new Date(now - 41_000).toISOString(), endedAt: new Date(now - 1_000).toISOString(), tokensBefore: 412_000, tokensAfter: 38_000 };

// fy-render
const parsedBlock = (...lines) => {
  const result = parseFyRender(lines.join('\\n'));
  if (!result.ok) throw new Error('fixture did not parse: ' + result.reason);
  return result.block;
};
const SVG_BLOCK = parsedBlock('type: svg', 'alt: Three bars rising', '---',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect x="10" y="30" width="20" height="30" fill="#6366f1"/><rect x="50" y="18" width="20" height="42" fill="#8b5cf6"/><rect x="90" y="6" width="20" height="54" fill="#ec4899"/></svg>');
const HTML_BLOCK = parsedBlock('type: html', 'alt: A counter widget', '---',
  '<button id="b" style="font:16px sans-serif;padding:8px 14px">Clicked 0 times</button><script>var n=0;b.onclick=function(){b.textContent="Clicked "+(++n)+" times"}</script>');

// dictation
const REVIEW_TAKE = {
  id: 1,
  raw: 'so um the ferretree daemon should uh fall back to the hosted relay when direct fails',
  cleaned: 'The Ferretry daemon should fall back to the hosted relay when direct fails.',
};

// conversations
const ago = hours => new Date(now - hours * 3_600_000).toISOString();
const CONVERSATIONS = [
  { id: 'c1', harness: 'claude', name: 'Checkout total: coupon plus gift card', project: '/work/shop', preview: 'Fix the checkout total when a coupon and a gift card are both applied', latest: 'Now add a test for the rounding', lastActivityAt: ago(2), turns: 14, model: 'Sonnet 5.5' },
  { id: 'c3', harness: 'claude', project: '/work/notes', preview: 'Summarise this week of meeting notes into a short list', latest: 'Add who owns each open question', lastActivityAt: ago(5), turns: 3, model: 'Haiku 5.5' },
  { id: 'c5', harness: 'codex', project: '/work/api/services/billing-gateway-with-a-long-folder-name', preview: 'Add retries to the invoice webhook', lastActivityAt: ago(80), turns: 22, model: 'GPT-6' },
];

// connection status
const DIRECT = { kind: 'direct', daemonUrl: 'https://studio.local:7431' };
const HOSTED = { kind: 'relay', relayUrl: 'wss://relay.ferretry.workers.dev', operator: 'hosted' };
const carriers = {
  direct: { choice: chooseConnection([{ method: DIRECT, reachable: true }]) },
  relayed: { choice: chooseConnection([{ method: DIRECT, reachable: false, detail: 'Failed to fetch' }, { method: HOSTED, reachable: true }]) },
  reconnecting: {
    choice: chooseConnection([{ method: DIRECT, reachable: false, detail: 'Failed to fetch' }, { method: HOSTED, reachable: true }]),
    health: {
      kind: 'reconnecting', since: 0, attempt: 3, nextAttemptAt: null,
      failures: [{ label: 'Direct', detail: 'Failed to fetch' }, { label: 'Hosted relay', detail: 'No daemon holds this rendezvous (4404).' }],
      cause: 'daemon-unreachable', stalled: true,
    },
  },
};

// stuck messages + context menu
const at = minute => '2026-10-19T07:' + String(minute).padStart(2, '0') + ':00.000Z';
const base = { attachmentIds: [] };
const stuckRecords = [
  { ...base, sendId: 'cancelled-cleared', acceptedAt: at(1), fate: 'cancelled', cancelEffect: 'cleared', message: 'rename the staging bucket to match the new naming scheme' },
  { ...base, sendId: 'cancelled-queue', acceptedAt: at(2), fate: 'cancelled', cancelEffect: 'left_in_queue', message: 'also bump the retry budget to five attempts' },
  { ...base, sendId: 'timed-out', acceptedAt: at(3), fate: 'timed_out', retryable: true, unaccountedReason: 'not_delivered', attempt: 2, message: 'summarise the failing checks on the open branch' },
  { ...base, sendId: 'typed', acceptedAt: at(4), fate: 'accepted', typedNotSent: true, message: 'continue with the second half of the plan, keeping the tests green' },
  { ...base, sendId: 'queued', acceptedAt: at(5), fate: 'queued', message: 'after that, tidy the changelog entry' },
  { ...base, sendId: 'sending', acceptedAt: at(6), fate: 'accepted', message: 'one more thing: please double-check the migration order' },
];
const stuckEntries = stuckRecords.map(record => ({ id: 'ledger:' + record.sendId, kind: 'ledger', text: record.message, ledger: record, placement: 'chronological' }));
const stuck = stuckSends(stuckRecords, Date.parse('2026-10-19T07:30:00.000Z'));
const nothing = () => undefined;
const menuSections = sessionActionSections([
  { group: 'session', order: 10, build: () => ({ id: 'copy-id', kind: 'run', label: 'Copy session id', icon: Copy, run: nothing }) },
  { group: 'session', order: 20, build: () => ({ id: 'rename', kind: 'form', label: 'Rename…', icon: Pencil, title: 'Rename', render: () => null }) },
  { group: 'move', order: 10, build: () => ({ id: 'move', kind: 'run', label: 'Move to another machine', icon: Server, unavailable: 'later', run: nothing }) },
  { group: 'learning', order: 10, build: () => ({ id: 'learn', kind: 'toggle', label: 'Passive learning', icon: Sparkles, checked: true, onToggle: nothing }) },
  { group: 'session', order: 30, build: () => ({ id: 'restart', kind: 'confirm', label: 'Restart CLI', icon: RotateCcw, question: 'Restart Hadi?', consequence: 'The CLI relaunches and keeps the conversation.', confirmLabel: 'Restart', run: nothing }) },
  { group: 'danger', order: 10, build: () => ({ id: 'stop', kind: 'confirm', label: 'Stop ferret', icon: Square, danger: true, question: 'Stop Hadi?', consequence: 'It stops working until you start it again.', confirmLabel: 'Stop ferret', run: nothing }) },
  clearStuckMessagesContribution(stuck, async () => undefined),
], { canControl: true });

// restart refusal
const REFUSAL = {
  status: 'running',
  turn: 7,
  blockedBy: 'unknown',
  items: [
    { kind: 'process', verdict: 'unknown', title: "A program Ferretry doesn't recognise is running", detail: 'python3 -m http.server 8080', age: '12m', blocks: true },
    { kind: 'tool', verdict: 'destructive_to_interrupt', title: 'A deploy command is mid-flight', detail: 'kubectl rollout status deploy/api', age: '41s', blocks: true },
  ],
  restartsWithCli: 2,
};
const DOWNGRADE = { model: 'claude-sonnet-5', targetWindow: 200_000, currentWindow: 1_000_000 };

// harness events + unbound + handoff
const TASKS = '/tmp/claude-1000/-home-kirin-Workspace-personal-ferretry/4ef0ca52/tasks';
const SETUP_DONE = [
  '<task-notification>',
  '<task-id>bdwjs9ydf</task-id>',
  '<output-file>' + TASKS + '/bdwjs9ydf.output</output-file>',
  '<status>completed</status>',
  '<summary>Background command "direnv allow &amp;&amp; (direnv exec . task setup &gt; /tmp/setup.log 2&gt;&amp;1)" completed (exit code 0)</summary>',
  '</task-notification>',
].join('\\n');
const GATE_FAILED = [
  '[SYSTEM NOTIFICATION - NOT USER INPUT]',
  'This is an automated background-task event, NOT a message from the user.',
  '',
  '<task-notification>',
  '<task-id>b0v6baykt</task-id>',
  '<output-file>' + TASKS + '/b0v6baykt.output</output-file>',
  '<status>failed</status>',
  '<summary>Background command "direnv exec . task test:gate" failed with exit code 144</summary>',
  '</task-notification>',
].join('\\n');
const AGENT_DONE = [
  '<task-notification>',
  '<task-id>afbd57ca787c50cef</task-id>',
  '<output-file>' + TASKS + '/afbd57ca787c50cef.output</output-file>',
  '<status>completed</status>',
  '<summary>Agent "CLI statusline tests for U7" finished</summary>',
  '<result>The statusline tests are written and passing: 21 pass, 0 fail.',
  '',
  'Nothing is committed and no source was edited.</result>',
  '<usage><subagent_tokens>278205</subagent_tokens><tool_uses>4</tool_uses><duration_ms>60219</duration_ms></usage>',
  '</task-notification>',
].join('\\n');
const EVENTS_LOG = [
  '[01:40:02] user/message: Set the worktree up and run the gate in the background.',
  '[01:41:30] user/message: ' + indent(SETUP_DONE),
  '[01:58:02] user/message: ' + indent(GATE_FAILED),
  '[02:03:40] user/message: ' + indent(AGENT_DONE),
  '[02:04:15] user/message: [Request interrupted by user]',
].join('\\n');
const unboundHello = {
  sendId: 'send-1',
  acceptedAt: '2026-10-19T07:12:00.000Z',
  message: 'hello',
  attachmentIds: [],
  fate: 'unaccounted',
  unaccountedReason: 'transcript_unbound',
};
const HANDOFF_STATE = '/home/kirin/.ferretry/state/sessions/ms0v8vgc-d445a669/turns';
const HANDOFF_LOG = [
  '[01:44:02] user/message: Can you check the onboarding screen?',
  '[01:44:30] assistant/message: Sure — what looks wrong?',
  '[01:45:10] user/message: ' + turnFileInstruction(HANDOFF_STATE + '/turn-008.md'),
  '[01:45:44] assistant/message: The **Continue** button sits under the keyboard at 390px. Fixing the inset now.',
].join('\\n');
const HANDOFF_DOC = 'On my phone the **Continue** button is hidden:\\n\\n- open onboarding\\n- tap the name field\\n- the keyboard covers the button';

// ---- the page ------------------------------------------------------------------------------------------
const Card = ({ slug, title, children }) => (
  <section data-card={slug} style={{ display: 'flow-root', margin: '0 0 28px', padding: '0 16px' }}>
    <h2 className="kt-label" style={{ margin: '0 0 8px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.75 }}>{title}</h2>
    {children}
  </section>
);
const InputColumn = ({ children }) => (
  <div className="fy-chat-input" data-session-input="">
    <div className="fy-chat-input__column">{children}</div>
  </div>
);

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <ReferenceSurfaceProvider surface={surface}>
    <PackSessionsProvider sessions={fleet}>
      <main style={{ margin: '0 auto', maxWidth: 760, padding: '16px 0' }}>
        <Card slug="baseline" title="Baseline: user bubble + assistant markdown">
          <Chat log={BASELINE_LOG} name="baseline" />
        </Card>
        <Card slug="pack-cards" title="Pack cards: recommend, refused, started, collected">
          <Chat log={PACK_LOG} name="pack" />
        </Card>
        <Card slug="peer-received" title="Peer messages: received">
          <Chat agent="Tanna" handoffs={{ 'turn-001': TOMI_TURN }} log={RECEIVER_LOG} name="peer-received" sends={receiverSends} />
        </Card>
        <Card slug="peer-sent" title="Peer messages: sent to">
          <Chat agent="Tomi" log={SENDER_LOG} name="peer-sent" sends={senderSends} />
        </Card>
        <Card slug="peer-failed" title="Peer messages: failed send">
          <Chat agent="Tomi" log={FAILED_LOG} name="peer-failed" sends={[]} />
        </Card>
        <Card slug="question-open" title="Question card: open">
          <QuestionCard questions={OPEN_QUESTION} />
        </Card>
        <Card slug="question-answered" title="Question card: answered">
          <QuestionCard questions={ANSWERED_QUESTION} />
        </Card>
        <Card slug="dialog-card" title="Harness startup dialog card">
          <InputColumn>
            <DialogCard agentName="Hadi" api={dialogApi} daemon={daemon} dialog={HOOKS} scope={scope} />
          </InputColumn>
        </Card>
        <Card slug="compaction" title="Compaction: running card, chip, done divider">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <CompactionCard compaction={compactionRunning} />
            <div><CompactionChip compaction={compactionRunning} /></div>
            <CompactionStrip compaction={compactionDone} />
          </div>
        </Card>
        <Card slug="fy-render-svg" title="Interactive block: SVG">
          <FyRenderBlock block={SVG_BLOCK} />
        </Card>
        <Card slug="fy-render-html" title="Interactive block: HTML frame chrome">
          <FyRenderBlock block={HTML_BLOCK} />
        </Card>
        <Card slug="dictation-review" title="Dictation review box">
          <DictationReviewBox onDiscard={nothing} onInsert={nothing} onRetry={nothing} review={REVIEW_TAKE} />
        </Card>
        <Card slug="conversation-rows" title="Conversation rows">
          <ul className="kt-panel fy-session-group__list fy-convo-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {CONVERSATIONS.map((row, index) => (
              <li className="fy-convo-item" data-selected={index === 0 ? '' : undefined} key={row.id}>
                <div className="fy-convo-main">
                  <ConversationLines
                    now={now}
                    row={row}
                    {...(index === 1 ? { ferret: { id: 'wren', name: 'wren', status: 'running' } } : {})}
                  />
                </div>
              </li>
            ))}
            <li className="fy-convo-item">
              <div className="fy-convo-main">
                <FerretLines cwd="/work/api" ferret={{ id: 'ash', name: 'ash', status: 'failed' }} harness="codex" lastActivityAt={ago(30)} now={now} />
              </div>
            </li>
          </ul>
        </Card>
        <Card slug="connection-status" title="Connection status: direct, relayed, reconnecting">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Object.entries(carriers).map(([name, props]) => (
              <ActiveCarrierCard key={name} machine="studio" relayAdvertised {...props} />
            ))}
          </div>
        </Card>
        <Card slug="context-menu" title="Session context menu (statically open)">
          {/* A transform makes the menu's fixed positioning relative to this box, so it sits in the page. */}
          <div data-menu-host="" style={{ height: 560, position: 'relative', transform: 'translateZ(0)' }}>
            <ContextActionsMenu anchor={{ x: 8, y: 8 }} name="Hadi" onClose={nothing} sections={menuSections} touch={false} />
          </div>
        </Card>
        <Card slug="stuck-messages" title="Stuck-message rows">
          <div className="fy-transcript-shell" style={{ height: 'auto', overflow: 'visible' }}>
            <div className="fy-transcript-content">
              {stuckEntries.map((entry, index) => (
                <TranscriptRow
                  entry={entry}
                  isLast={index === stuckEntries.length - 1}
                  key={entry.id}
                  onCancel={async () => true}
                  onRetry={async () => true}
                  onSubmit={async () => true}
                  previous={stuckEntries[index - 1]}
                />
              ))}
            </div>
          </div>
        </Card>
        <Card slug="harness-events" title="Harness event rows">
          <Chat log={EVENTS_LOG} name="events" />
        </Card>
        <Card slug="transcript-unbound" title="Transcript-unbound notice">
          <TranscriptUnboundNotice onCheckAgain={nothing} onRestart={async () => undefined} />
        </Card>
        <Card slug="handoff" title="Hand-off message">
          <Chat agent="Janella" handoffs={{ 'turn-008': HANDOFF_DOC }} log={HANDOFF_LOG} name="handoff" />
        </Card>
        <Card slug="approval-card" title="Approval card">
          <InputColumn>
            <ApprovalCard agentName="Hadi" api={approvalApi} daemon={daemon} request={SHELL} scope={scope} />
          </InputColumn>
        </Card>
        <Card slug="restart-refusal" title="Restart refusal panels (statically placed)">
          {/* The panels are fixed to the viewport bottom; a transform makes each fixed to its own box. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ height: 380, position: 'relative', transform: 'translateZ(0)' }}>
              <RestartRefusalPanel busy={false} failure={null} onCancel={nothing} onRestartAnyway={nothing} refusal={REFUSAL} />
            </div>
            <div style={{ height: 230, position: 'relative', transform: 'translateZ(0)' }}>
              <RestartDowngradePanel busy={false} downgrade={DOWNGRADE} failure={null} onCancel={nothing} onRestartAnyway={nothing} />
            </div>
          </div>
        </Card>
        <Card slug="fast-switch" title="Fast switch: off, on, switching, failed">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <FastSwitch onPress={nothing} pressed={false} />
            <FastSwitch onPress={nothing} pressed />
            <FastSwitch mark="switching" onPress={nothing} pressed />
            <FastSwitch mark="failed" onPress={nothing} pressed={false} />
          </div>
        </Card>
      </main>
    </PackSessionsProvider>
  </ReferenceSurfaceProvider>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/theme-gallery-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'theme-gallery-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'theme-gallery-entry.tsx'), '--outdir', outDir, '--target', 'browser']);
// The generated entry is untyped page code: leaving it under harness/ would put it in the PWA typecheck.
rmSync(join(outDir, 'theme-gallery-entry.tsx'), { force: true });
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(outDir, 'app.css'),
]);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    const file = Bun.file(join(outDir, url.pathname));
    // The fy-render HTML shell is a generated Pages asset that is not built here: answer 404, not a crash.
    return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

try {
  for (const theme of THEMES) {
    if (onlyTheme !== undefined && theme !== onlyTheme) continue;
    const scheme = theme.endsWith('-dark') ? 'dark' : 'light';
    for (const viewport of VIEWPORTS) {
      if (onlyViewport !== undefined && viewport.name !== onlyViewport) continue;
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        isMobile: viewport.mobile,
        hasTouch: viewport.mobile,
        timezoneId: 'Asia/Tokyo',
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        // The open menu dismisses itself on any window resize, which the full-page capture performs. The
        // viewport's width never changes here, so listeners for `resize` are simply not registered.
        await context.addInitScript(() => {
          const add = window.addEventListener.bind(window);
          window.addEventListener = ((type: string, ...rest: unknown[]) =>
            type === 'resize'
              ? undefined
              : (add as (...args: unknown[]) => void)(type, ...rest)) as typeof window.addEventListener;
        });
        const page = await context.newPage();
        const problems: string[] = [];
        page.on('pageerror', error => problems.push(error.message));
        await page.goto(`${server.url}?theme=${theme}`);
        await page
          .locator('[data-card="pack-cards"] [data-pack-state="started"]')
          .first()
          .waitFor({ state: 'visible' });
        await page.locator('[data-card="stuck-messages"] [data-ledger-action]').first().waitFor({ state: 'visible' });
        // The folds a reader would open: the ranked models, a sub-ferret's brief, the guarded retry and
        // what each cancel did, then the menu's confirm row.
        await page.locator('[data-card="pack-cards"] [data-pack-kind="recommend"] summary').first().click();
        await page
          .locator('[data-card="pack-cards"] [data-pack-state="started"]')
          .last()
          .locator('.fy-pack-fold summary')
          .click();
        await page.locator('[data-ledger-action="retry-open"]').first().click();
        for (const receipt of await page.locator('[data-send-fate="cancelled"]').all()) await receipt.click();
        // Fonts and layout settle, then the viewport is sized to the whole page so the full-page capture
        // performs no resize (a resize closes the open menu), and only then the menu's confirm row is opened.
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        await page.waitForTimeout(400);
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.setViewportSize({ width: viewport.width, height });
        await page.waitForTimeout(400);
        await page.locator('[data-session-action-item="clear-stuck-messages"]').click();
        await page.locator('[data-menu-confirm="clear-stuck-messages"]').waitFor({ state: 'visible' });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`${theme} ${viewport.name} scrolls sideways by ${overflow}px`);
        if (problems.length > 0) fail(`${theme} ${viewport.name} page errors: ${problems.join(' | ')}`);
        const target = join(outDir, `theme-gallery-${theme}-${viewport.name}.png`);
        await page.screenshot({ path: target, fullPage: true });
        process.stdout.write(`📸 ${target}\n`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
