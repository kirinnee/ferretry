/** Moves and forks (ferrets-c): fork, handover, conversion preview, move. */
import { audit } from '@ferretry/core-gate/contract';
import { route, verb } from '@ferretry/kernel/manifest';
import { ferretRead, FLEET_CONFIGURE, fragment } from '../kit.ts';

export default fragment({
  routes: [
    // ── moves and forks (ferrets-c): today's descriptors from mounts/session-{fork,handover,migrate}.ts, field for
    // field; paths /v1/sessions/:sessionId/… → /v1/ferrets/:ferretId/…, migrate → move (§1.4).
    // R-0344
    route('POST /v1/ferrets/:ferretId/fork', {
      minimum: 'operator',
      caller: 'person',
      capability: FLEET_CONFIGURE,
      noStore: true,
      audit: audit('session.opened'),
      guard: { none: 'the fresh ferret summary and the public plan projection; no transcript text' },
    }),
    // R-0345
    route('POST /v1/ferrets/:ferretId/handover', {
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_CONFIGURE,
      noStore: true,
      audit: { skip: 'drives an existing session; its journal records it' },
      guard: { none: 'the handover receipt: ids, phases and accounts, no transcript text' },
    }),
    // R-0154
    ferretRead('GET /v1/ferrets/:ferretId/handover', {
      minimum: 'authenticated',
      audit: { skip: 'a read of the handover receipt records nothing' },
      guard: { none: 'the handover receipt: ids, phases and accounts, no transcript text' },
    }),
    // R-0346
    route('POST /v1/ferrets/:ferretId/handover/cancel', {
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_CONFIGURE,
      noStore: true,
      audit: { skip: 'drives an existing session; its journal records it' },
      guard: { none: 'the handover receipt: ids, phases and accounts, no transcript text' },
    }),
    // R-0169
    ferretRead('GET /v1/ferrets/:ferretId/relaunch-settings', {
      audit: { skip: 'a read records nothing' },
      guard: { none: 'whether the launch settings drifted, and which kind; no setting values' },
    }),
    // R-0341
    route('POST /v1/ferrets/:ferretId/conversion-preview', {
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_CONFIGURE,
      noStore: true,
      audit: {
        skip: 'a read with a body: previews a cross-harness conversion and writes nothing; the move it precedes is audited',
      },
      guard: { none: 'conversion counts and versions; no transcript text' },
    }),
    // R-0355
    route('POST /v1/ferrets/:ferretId/move', {
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_CONFIGURE,
      noStore: true,
      audit: { skip: 'drives an existing session; its journal records it' },
      guard: { none: 'the moved ferret view, or the in-flight inventory as titles and trimmed commands' },
    }),
    // R-0356
    route('POST /v1/ferrets/:ferretId/move/ask-to-stop-jobs', {
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_CONFIGURE,
      noStore: true,
      audit: audit('agent.prompted'),
      guard: { none: 'the queued message id and the jobs as pid and trimmed command' },
    }),
  ],
  cli: [
    // V-0329: `fy migrate <id>` → `fy ferret move <id>` (§1.4).
    verb('ferret move <id>', {
      summary: 'continue a ferret on another runtime (another harness only with --convert)',
      args: [{ name: 'id', help: 'session id or callsign' }],
      options: [
        { flag: '-a, --agent <agent>', help: 'the runtime to move the session onto' },
        { flag: '--model <model>', help: "override the model; defaults to the target account's configured model" },
        {
          flag: '--allow-context-downgrade',
          help: 'accept a target context window smaller than the current one (the daemon otherwise refuses)',
        },
        {
          flag: '--force-inflight',
          help: 'go ahead even though the daemon could not show that what the agent is running is safe to stop (the daemon otherwise refuses; the move is journalled)',
        },
        {
          flag: '--conversation <choice>',
          help: 'resume (default) continues the conversation the session is on; fresh starts a new one; previous goes back to the one an earlier Restart left behind; convert rewrites it for the other harness',
        },
        {
          flag: '--convert',
          help: 'move onto a runtime of the OTHER harness (Claude ↔ Codex) by converting the conversation; same as --conversation convert',
        },
        { flag: '--preview', help: 'with --convert: show what the conversion would carry and change nothing' },
        { flag: '--request-id <id>', help: 'stable idempotency key for an explicit retry of this move' },
        { flag: '--json', help: 'print the moved session as JSON' },
      ],
    }),
  ],
});
