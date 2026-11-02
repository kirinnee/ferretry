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
  'POST /v1/catalog-items/:itemId/versions/preview':
    'a read with a body (an empty one): re-reads the item’s source and shows what would change; writes nothing; the publish is audited',
  'POST /v1/catalogs/:id/items/preview':
    'a read with a body: previews what a publish would carry and writes nothing; the add it precedes is audited',
  'PATCH /v1/catalog-members/:memberId':
    'renames a person in the owner’s own list; it changes nobody’s access, and the log keeps the grants and removals',
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
  'PUT /v1/board/projects/:projectId/switch':
    'switches whether a project uses the board; owner-only, it changes nobody’s access, and the switch records that the owner set it and when',
  'POST /v1/search/related':
    'a read: a POST only because a title and an ask do not fit a URL; it weighs them against the board and changes nothing',
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
  'POST /v1/catalog-installs/project/preview':
    'a read with a body: verifies a signed catalog item and shows the review; writes nothing and pins nothing; the apply is audited',
  'POST /v1/catalog-installs/runtime/preview':
    'a read with a body: verifies a signed catalog item and shows the review; writes nothing and pins nothing; the apply is audited',
  'POST /v1/skill-installs/local/project/preview':
    'a read with a body: shows the full review of a skill on this machine and writes nothing; the apply is audited',
  'POST /v1/skill-installs/local/runtime/preview':
    'a read with a body: shows the full review of a skill on this machine and writes nothing; the apply is audited',
  'GET /v1/skill-installs/local': 'a read: lists the copies this machine recorded; changes nothing',
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
  'POST /v1/agenda/clear-agents':
    "the owner dismissing every open agenda item of the agent ferrets; each item's own history records the dismissal and its note, and it widens nobody's access",
  'POST /v1/sessions/:sessionId/notify': 'an agent notifying; its payload is labelled with the agent (see L5)',
  'POST /v1/sessions/:sessionId/pins': 'a bookmark in a transcript',
  'POST /v1/sessions/:sessionId/shared-draft':
    "the owner's own unsent words, typed at keystroke rate; it widens nobody's access, and logging it would copy the draft into a log",
  'POST /v1/board/tasks': 'a work card on a project board; its own append-only history records who did what',
  'POST /v1/board/tasks/:taskId': 'a work card on a project board; its own append-only history records who did what',
  'POST /v1/board/skip':
    'a ferret recording on its own session why its work has no card; the session config keeps the reason and when',
  'POST /v1/board/import':
    'a one-time import of the old per-session task files; every card it makes ends with a migrated history event and the daemon logs the summary',
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
  'GET /v1/input-requests': 'a read; carries no value',
  'GET /v1/sessions/:sessionId/input-requests': 'a read; carries no value',
  'POST /v1/sessions/:sessionId/input-requests/:requestId/deliver':
    'audited by the input-request service: input.delivered or input.refused, names and flags only, never the value',
  'POST /v1/sessions/:sessionId/input-requests/:requestId/cancel':
    'audited by the input-request service: input.cancelled, names and flags only',
  'GET /v1/sessions/:sessionId/input-quarantines': 'a read; names and end times only',
  'POST /v1/sessions/:sessionId/phone-approvals/:approvalId/refuse':
    'audited by the phone-approval service: phone-approval.refused, the account, the site and the ferret, never the number',
  'POST /v1/sessions/:sessionId/task-plans/:planId/approval':
    'stages a selection, which approves nothing; a paste-only answer is audited by the task-plan service: security.changed task-plan-answered, line by line, never a value',
  'POST /v1/sessions/:sessionId/task-plans/:planId/approval/:stage/commit':
    'audited by the task-plan service: security.changed task-plan-answered with the passkey proof, line by line; the step-up that proved it is audited too',
  'POST /v1/sessions/:sessionId/task-plans/:planId/approval/:stage/confirm-in-app':
    "shows a staged selection on the plan's own card; it approves nothing, and the commit that would is audited",
  'DELETE /v1/sessions/:sessionId/task-plans/:planId/approval/:stage': 'drops a staged selection; approves nothing',
  'POST /v1/sign-in-rules/stages': 'stages a standing rule, which approves nothing; the commit that would is audited',
  'POST /v1/sign-in-rules/stages/:stage/confirm-in-app':
    'shows a rule staged at the machine in the app; it approves nothing, and the commit that would is audited',
  'POST /v1/sign-in-rules/stages/:stage/bind':
    'a paired device takes a machine-staged rule to approve it with its own passkey; it approves nothing, and the commit that would is audited',
  'POST /v1/sign-in-rules/stages/:stage/commit':
    'audited by the standing-rule service: security.changed sign-in-rule-created (or -resumed, -renewed, -widened) with the device and the passkey; the step-up that proved it is audited too',
  'DELETE /v1/sign-in-rules/stages/:stage': 'drops a staged standing rule; approves nothing',
  'DELETE /v1/sign-in-rules/suggestions/:sid':
    'forgets a standing-rule suggestion held in memory; it grants nothing (the suggestion itself is audited as sign-in-rule-suggested)',
  'POST /v1/sign-in-rules/:id/narrow':
    'only narrows; audited by the standing-rule service: security.changed sign-in-rule-narrowed',
  'DELETE /v1/sign-in-rules/:id':
    'only narrows; audited by the standing-rule service: security.changed sign-in-rule-revoked',
  'POST /v1/accounts/:id/sign-in-rules/revoke':
    'only narrows; audited by the standing-rule service: security.changed sign-in-rule-revoked, one record per rule',
  'POST /v1/sessions/:sessionId/task-plans/:planId/revoke':
    'only narrows; audited by the task-plan service: security.changed task-plan-ended',
  'POST /v1/sessions/:sessionId/input-quarantines/:key/end':
    'audited by the input-request service: input.quarantine_ended, names and flags only',
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
  'GET /v1/sessions/:sessionId/shared-draft/stream':
    "the owner's own unsent words at keystroke rate, to the owner's own devices; logging it would copy the draft into a log",
};
