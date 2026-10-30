/**
 * EVERY MUTATING ROUTE THE SECURITY LOG DELIBERATELY DOES NOT RECORD, AND WHY.
 *
 * The contract in `tests/unit/runtime/mounts/surface.test.ts` reads the whole mounted table: a route
 * that is not GET must be on `AUDITED_ROUTES` or here, and every line here must still name a mounted
 * route. So a new route cannot slip past the log unreviewed, and a route that is deleted or starts
 * being audited cannot leave a stale excuse behind. THIS LIST ONLY SHRINKS: adding a line is a
 * review decision — say what the route does to WHO may reach this machine, and why that is nothing.
 *
 * The log's question is "who reached this machine and what did they do with the access". Routes that
 * only drive an agent the caller is already allowed to drive are the session's own history — its
 * transcript and its journal — not the machine's security history.
 */
export const NOT_AUDITED: Readonly<Record<string, string>> = {
  'POST /v1/fleet/credentials/:credentialId/check': 'a read with a side effect of refreshing a status; changes nothing',
  'POST /v1/fleet/profiles/preview': 'a read with a body: previews a draft and writes nothing',
  'POST /v1/sessions/:sessionId/conversion-preview':
    'a read with a body: previews a cross-harness conversion and writes nothing; the migrate it precedes is audited',
  'POST /v1/passkeys/options': 'mints a one-time challenge; the registration that spends it is audited',
  'POST /v1/step-up/options': 'mints a one-time challenge; the step-up that spends it is audited',
  'POST /v1/unlock/options': 'mints a one-time challenge; the unlock that spends it is audited',
  'POST /v1/secrets/imports':
    'mints a one-time public key for a secret copy; the import that spends it is audited under its id',
  'PATCH /v1/cgroups/config': 'resource limits on the host’s own sessions; not who may reach the machine',
  'POST /v1/gc': 'scratch cleanup of state the daemon owns; reaches nobody',
  'POST /v1/system/open-url':
    'audited as link.opened by the service, which sees the address; the route decorator cannot read the body',
  'POST /v1/diagnostics/profile': 'opens a read-only window onto the daemon’s own counters; changes nothing',
  'POST /v1/projects':
    'registers a working directory; governed by filesystem.configure and listed in the project table',
  'POST /v1/board/projects/:projectId/lanes':
    'proposes, edits or confirms a project board’s lanes; a board layout changes nobody’s access, and the lane set records who proposed and who confirmed it',
  'POST /v1/worktrees':
    'creates a worktree inside a registered project; removal is the destructive half and is audited',
  'POST /v1/sessions/:sessionId/stop': 'drives an existing session; its journal records it',
  'POST /v1/sessions/:sessionId/resume': 'drives an existing session; its journal records it',
  'POST /v1/sessions/:sessionId/migrate': 'drives an existing session; its journal records it',
  'POST /v1/restarts': 'drives existing sessions through the migrate; each journal records it',
  'DELETE /v1/restarts': 'clears a queue of pending restarts of sessions the caller already drives',
  'POST /v1/sessions/:sessionId/handover': 'drives an existing session; its journal records it',
  'POST /v1/sessions/:sessionId/handover/cancel': 'drives an existing session; its journal records it',
  'POST /v1/sessions/:sessionId/runtime': 'drives an existing session; its journal records it',
  'POST /v1/sessions/:sessionId/signal': 'an agent reporting its own status',
  'POST /v1/sessions/:sessionId/rename':
    'a label, not an authority; the session journal records session.renamed with its actor',
  'POST /v1/mcp/check':
    'a read with a body: opens and closes one MCP session to list its tools; changes no configuration and grants nobody anything',
  'POST /v1/sessions/:sessionId/mcp/project/preview':
    'a read with a body: previews a .mcp.json change and writes nothing; the add is audited',
  'POST /v1/sessions/:sessionId/mcp/login/preview':
    'a read with a body: previews a login MCP add and writes nothing; the add is audited',
  'POST /v1/sessions/:sessionId/interrupt': 'drives an existing session; its journal records it',
  'POST /v1/sessions/:sessionId/attachments': 'a file handed to an agent; the transcript is that history',
  'POST /v1/sessions/:sessionId/attachments/:attachmentId/unlock': 'opens an attachment to its own session only',
  'DELETE /v1/sessions/:sessionId/attachments/:attachmentId/unlock': 'closes an attachment again',
  'POST /v1/sessions/:sessionId/attention': 'an agent raising attention; the agenda list is that history',
  'POST /v1/sessions/:sessionId/attention/replies':
    'the owner skipping the settle window for answers already recorded; the send ledger is that history',
  'POST /v1/sessions/:sessionId/agenda':
    'an agent raising an agenda item (the agenda spelling of the agenda route above); the agenda list is that history',
  'POST /v1/sessions/:sessionId/agenda/replies':
    'the owner skipping the settle window for answers already recorded (the agenda spelling of the agenda route above); the send ledger is that history',
  'POST /v1/sessions/:sessionId/notify': 'an agent notifying; its payload is labelled with the agent (see L5)',
  'POST /v1/sessions/:sessionId/pins': 'a bookmark in a transcript',
  'POST /v1/sessions/:sessionId/tasks': 'a task record on a session',
  'POST /v1/sessions/:sessionId/tasks/:taskId': 'a task record on a session',
  'POST /v1/board/tasks': 'a work card on a project board; its own append-only history records who did what',
  'POST /v1/board/tasks/:taskId': 'a work card on a project board; its own append-only history records who did what',
  'POST /v1/task-boards/create': 'coordination between sessions; the board is its own ledger',
  'POST /v1/task-boards/child-grants/request': 'coordination between sessions; the board is its own ledger',
  'POST /v1/task-boards/child-grants/approve': 'coordination between sessions; the board is its own ledger',
  'POST /v1/task-boards/invitations/request': 'coordination between sessions; the board is its own ledger',
  'POST /v1/task-boards/invitations/approve': 'coordination between sessions; the board is its own ledger',
  'POST /v1/task-boards/invitations/accept': 'coordination between sessions; the board is its own ledger',
  'POST /v1/task-boards/invitations/verify': 'a read with a body: verifies an invitation and writes nothing',
  'POST /v1/task-boards/membership/relinquish': 'coordination between sessions; the board is its own ledger',
  'POST /v1/task-boards/coordinator/replace': 'coordination between sessions; the board is its own ledger',
  'PATCH /v1/analytics/pricing': 'the cost table for usage reports; reaches nobody',
  'POST /v1/analytics/pricing/sync/preview': 'a read with a body: previews a price sync',
  'POST /v1/analytics/pricing/sync/apply': 'the cost table for usage reports; reaches nobody',
  'POST /v1/sessions/:sessionId/terminals/:terminalId': 'renames a terminal; opening and attaching are audited',
  // The agent tools are audited MORE finely than this table can: a route rule may read a path parameter
  // and response names, never the body, and what matters here — which tool, on which named surface,
  // how much was typed — is in the body. `AgentToolService` writes one `agent.tool` record per call and
  // one `surface.control` record per takeover or hand back itself, refusals included.
  'POST /v1/agent/tools': 'audited per call by the agent-tools service: tool, surface name and lengths',
  'POST /v1/sessions/:sessionId/surfaces/terminals/tools':
    'audited per call by the agent-tools service: tool, surface name and lengths',
  'POST /v1/sessions/:sessionId/surfaces/browser/tools':
    'audited per call by the agent-tools service: tool, surface name and lengths',
  'POST /v1/sessions/:sessionId/surfaces/terminals/control':
    'audited per takeover and hand back by the agent-tools service',
  'POST /v1/sessions/:sessionId/surfaces/browser/control':
    'audited per takeover and hand back by the agent-tools service',
  'DELETE /v1/sessions/:sessionId/terminals/:terminalId':
    'closes a terminal, which removes access rather than adding it',
  'POST /v1/learning/proposals/:id': 'accepts or declines a learning suggestion for a skill file; reaches nobody',
  'POST /v1/learning/run': 'starts a learning pass over transcripts the daemon already holds',
  'PATCH /v1/sessions/:sessionId/learning':
    'switches whether one ferret files lessons; changes no access, and its re-instruction is in its transcript',
  'PATCH /v1/sessions/:sessionId/hypermedia':
    'switches what one ferret is told about presentation at its next launch; changes no access',
  'PATCH /v1/sessions/:sessionId/agenda-mode':
    'switches whether one ferret keeps an agenda at its next launch; it changes no access and only what the ferret is told',
  'PATCH /v1/sessions/:sessionId/pack':
    'switches whether one ferret is told about sub-ferrets at its next launch; it grants nothing a start could not',
  'POST /v1/pack/recommend': 'a read with a body: lists the models usable now for a task',
  'POST /v1/learning/scan/estimate': 'a read with a body: counts what a scan would read and cost',
  'POST /v1/learning/scan': 'starts miners over transcripts the daemon already holds; reaches nobody',
  'POST /v1/learning/scan/cancel': 'stops the miners a scan started; removes work rather than adding access',
  'POST /v1/agent/lessons': 'a ferret filing a lesson into the inbox for the owner to review; reaches nobody',
  'POST /v1/recommend': 'a read with a body: recommends a model for a task',
  'POST /v1/stt/enhance': 'a read with a body: tidies dictated text',
  'POST /v1/webrtc/offer':
    'opens a peer-to-peer path, not an act: every session on it proves its device again and meets the same guard',
  'POST /v1/models/refresh': 'asks the hosted app for a newer model catalog; labels and ids, grants nothing',
  'POST /v1/models/local/refresh':
    'reads the model names Ollama has installed on this machine, as `ollama list` does; spends and changes nothing',
};

/** Protocol-switching routes the log does not record. */
export const NOT_AUDITED_SOCKETS: Readonly<Record<string, string>> = {
  'GET /v1/events': 'the fleet event feed is a read: it shows what the caller could already list',
};
