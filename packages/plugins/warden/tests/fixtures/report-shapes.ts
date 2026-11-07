/**
 * The 39 Warden investigations one host paid for between 26 and 28 October 2026 (about $6.29), reduced
 * to the SITUATION each report found — synthetic and secret-free: no report text, no paths, no
 * transcript, only what the liveness layer can observe.
 *
 * Every row is what the investigator saw when it got there:
 *
 * - `turnState` — whose move it was;
 * - `pane` — what ran under the ferret's pane, beyond the harness itself (`fy mcp serve` is under
 *   every pane, as it is in production);
 * - `moving` — whether the transcript and the screen were moving (the session was doing work).
 *
 * The verdict line is the report's own outcome, kept so the test can say which ones were real.
 */

export type ReportCategory =
  | 'tools-server' // the ferret's own `fy mcp serve`, alive as long as the session
  | 'idle' // finished, idle at the prompt, nothing running
  | 'other-session' // a process that belonged to ANOTHER session was blamed on this one
  | 'tmux-reader' // the daemon's own read-only tmux client was blamed on this one
  | 'leftover-browser' // an idle headless Chrome the agent left behind
  | 'dev-server' // a board/dev server the agent left listening on purpose
  | 'dev-server-busy' // the same, while the ferret was actively working
  | 'ci-watch' // `gh pr checks --watch` while the ferret was fixing a failing check
  | 'ci-poll-loop' // an `until` loop polling PR checks whose exit condition can never be met
  | 'dead-monitor'; // the fleet sweep's one non-sus flag

export interface ReportShape {
  readonly at: string;
  readonly ferret: string;
  readonly kind: 'sus_subprocess' | 'dead_monitor';
  readonly verdict: 'LEAVE' | 'KILL' | 'NUDGE';
  readonly category: ReportCategory;
  /** True for the one report whose finding was genuinely worth the money. */
  readonly real?: true;
}

export const REPORT_SHAPES: readonly ReportShape[] = [
  { at: '2026-10-26T05:19Z', ferret: 'delfino', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'tools-server' },
  { at: '2026-10-26T05:21Z', ferret: 'lanny', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'leftover-browser' },
  {
    at: '2026-10-26T05:23Z',
    ferret: 'dillion',
    kind: 'sus_subprocess',
    verdict: 'LEAVE',
    category: 'leftover-browser',
  },
  { at: '2026-10-26T05:51Z', ferret: 'delfino', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'idle' },
  { at: '2026-10-26T05:53Z', ferret: 'lanny', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'idle' },
  { at: '2026-10-26T05:55Z', ferret: 'dillion', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'dev-server-busy' },
  { at: '2026-10-26T06:23Z', ferret: 'delfino', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'idle' },
  { at: '2026-10-26T06:27Z', ferret: 'lanny', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'leftover-browser' },
  { at: '2026-10-26T06:29Z', ferret: 'dillion', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'dev-server' },
  { at: '2026-10-26T07:25Z', ferret: 'delfino', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'tools-server' },
  { at: '2026-10-26T07:29Z', ferret: 'lanny', kind: 'sus_subprocess', verdict: 'KILL', category: 'leftover-browser' },
  {
    at: '2026-10-26T07:31Z',
    ferret: 'dillion',
    kind: 'sus_subprocess',
    verdict: 'LEAVE',
    category: 'leftover-browser',
  },
  { at: '2026-10-26T08:01Z', ferret: 'lanny', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'tools-server' },
  { at: '2026-10-26T09:27Z', ferret: 'delfino', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'tools-server' },
  { at: '2026-10-27T00:00Z', ferret: 'fransisco', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'tools-server' },
  { at: '2026-10-27T00:02Z', ferret: 'lanny', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'tools-server' },
  { at: '2026-10-27T00:04Z', ferret: 'dillion', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'dev-server' },
  { at: '2026-10-27T00:32Z', ferret: 'fransisco', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'tools-server' },
  { at: '2026-10-27T00:36Z', ferret: 'lanny', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'idle' },
  { at: '2026-10-27T00:38Z', ferret: 'dillion', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'idle' },
  { at: '2026-10-27T01:04Z', ferret: 'fransisco', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'tools-server' },
  { at: '2026-10-27T01:10Z', ferret: 'lanny', kind: 'sus_subprocess', verdict: 'KILL', category: 'idle' },
  { at: '2026-10-27T01:12Z', ferret: 'dillion', kind: 'sus_subprocess', verdict: 'NUDGE', category: 'idle' },
  { at: '2026-10-27T01:42Z', ferret: 'lanny', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'tools-server' },
  { at: '2026-10-27T01:46Z', ferret: 'dillion', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'dev-server' },
  { at: '2026-10-27T02:06Z', ferret: 'fransisco', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'tools-server' },
  { at: '2026-10-27T02:18Z', ferret: 'dillion', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'dev-server' },
  {
    at: '2026-10-28T00:00Z',
    ferret: 'tennyson',
    kind: 'sus_subprocess',
    verdict: 'NUDGE',
    category: 'ci-poll-loop',
    real: true,
  },
  { at: '2026-10-28T00:04Z', ferret: 'briefer', kind: 'sus_subprocess', verdict: 'KILL', category: 'idle' },
  { at: '2026-10-28T00:08Z', ferret: 'lanny', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'other-session' },
  { at: '2026-10-28T00:12Z', ferret: 'dillion', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'other-session' },
  { at: '2026-10-28T00:38Z', ferret: 'briefer', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'tmux-reader' },
  { at: '2026-10-28T00:42Z', ferret: 'lanny', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'other-session' },
  { at: '2026-10-28T01:00Z', ferret: 'dillion', kind: 'sus_subprocess', verdict: 'KILL', category: 'idle' },
  { at: '2026-10-28T01:12Z', ferret: 'briefer', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'tools-server' },
  { at: '2026-10-28T01:16Z', ferret: 'lanny', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'tmux-reader' },
  { at: '2026-10-28T01:32Z', ferret: 'fixer', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'ci-watch' },
  { at: '2026-10-28T01:38Z', ferret: 'dillion', kind: 'sus_subprocess', verdict: 'LEAVE', category: 'dev-server' },
  { at: '2026-10-28T01:43Z', ferret: 'reviver', kind: 'dead_monitor', verdict: 'LEAVE', category: 'dead-monitor' },
];
