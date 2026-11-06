import { describe, it } from 'bun:test';
import should from 'should';
import type { ApiResponse } from '../../../../src/lib/api/http.ts';
import { MemberDispatcher, type SharedRouteDeps } from '../../../../src/lib/catalog-members/shared-routes.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { PREFIXED_S1 } from '../../agent-tools/support.ts';
import { jsonBody, request } from '../../api/support.ts';
import { scratchGcRoutes } from '../../../../src/lib/runtime/mounts/scratch-gc.ts';
import { builtSharedDraftsKnowing } from '../../modules/shared-drafts/fixture.ts';
import { FRAGMENTS, NOT_AUDITED, OTHER_TABLE_CALLERS, ROUTE_CALLERS } from '../../modules/route-contracts.ts';
import { agentIn, CREDENTIALS, grantSubsystem, human } from './support.ts';
import {
  createMountedDispatcher,
  createMountedSocketDispatcher,
  mountedAuditRules,
  mountedDaemonRoutes,
  mountedSocketRoutes,
} from './surface-mounted.ts';
import { base, subsystems } from './surface-world.ts';

/**
 * The canonical order every list of mounted routes is compared in: sorted by `METHOD path`, requests and sockets
 * in separate lists. Mount order is an implementation detail (the dispatcher orders by specificity), so no
 * expectation here names it, and an extraction never has to move a line in a shared list. A copy: duplicates stay.
 */
const canonical = (lines: readonly string[]): readonly string[] => [...lines].sort();

/** The daemon package, read by the route declaration inventory check. */
const DAEMON_ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/u, '');

describe('the mounted daemon surface', () => {
  it('should declare credential and privileged-arrival requirements independently', () => {
    const mounted = subsystems();
    const routes = [...mountedDaemonRoutes(base, mounted), ...mountedSocketRoutes(mounted)];
    const minima = routes.reduce<Record<string, number>>((counts, route) => {
      counts[route.minimum] = (counts[route.minimum] ?? 0) + 1;
      return counts;
    }, {});

    // `admin-token` is declared by exactly ONE route: the owner's re-opened passkey window (review L3),
    // so a paired device is refused at the boundary before the service's own at-the-machine check. The
    // fleet's old approval-code route used it once too, and is gone. The agent tools route is `none` and
    // privileged: it carries no host authority, only the session credential it checks itself.
    // Written as a LABELLED sum, one term per line, and that is the anti-merge device rather than
    // style: a bare `129 + 5 + 1 + 1` invited two changes to each append `+ 1` and produce the same
    // total, which git merges without a conflict — exactly how a route goes missing with this test
    // green. Two additions here both have to rewrite the line that carries the terminating `;`.
    const operatorRoutes =
      107 + // the session table and everything that is not the account model (three of them the agenda's versions: the list kept of an item, one version in full, and the device's seen mark; one of them cutting a ferret off: its credential revoked; six of them the send ledger: its read, one send, a retry under the same id, a cancel, an Enter for one typed and not sent, and the hand-off document behind a pointer; three the session's durable message queue: its read, an edit and a take-back of a message still waiting; one the Enter or erase for a person's own draft in the composer) (the ferret limits are read-only now: the PATCH that edited them is gone, `limits.yaml` is the one writer) (three socket-ticket counters gone: a device opens streams inside its session; the operator password's set and unlock routes gone: the passkey step-up replaced them)
      2 + // the owner's view of who holds the terminal slots, and closing the finished ferrets' terminals (`fy terminal close --all-finished`)
      8 + // the project boards: the board query, its card ids, a PR's merge gate (docs/design/clash-queue.md), one card, a new card, an action on a card (board-design.md §2), a ferret's skip (§3.4), and the owner's start of a new ferret on a card (docs/board.md, "Start a ferret on a card")
      1 + // bounded full-conversation reads, including historical version threads
      2 + // the work search over cards and agenda items, and the related check before filing (docs/work-search.md)
      1 + // one ferret's tidy plan: its own unwanted cards and work-tracking agenda items (docs/board.md, "Tidy")
      1 + // one full session agenda item behind a resolved list header
      3 + // the machine agenda: its list, one full item and the owner's dismiss, snooze or resolve (docs/agenda.md, "The machine agenda")
      1 + // an agenda item the owner opened, so its alerts come down on their other devices (`POST /v1/push/seen`)
      4 + // the credential sign-in family: start, then read, answer or cancel one flow
      5 + // the MCP sign-in family: its status read, start, finish, cancel and sign out (docs/mcp-oauth.md)
      3 + // every MCP server a ferret sees, for the machine and for one ferret, and checking one (docs/mcp-scopes.md)
      2 + // the account model's credential list and its Check now
      3 + // copying secrets to another machine: open an import, seal for one, file one (docs/secrets.md)
      2 + // an environment login's Test, and the provider presets one is made from (docs/provider-presets.md)
      7 + // the account model's four catalogue reads and its three proposal routes
      1 + // the draft-profile preview, a read with a body
      6 + // the setup scan, tool install, the clone export, the clone review, forgetting a copy source and the record of the keys a sealed copy filed
      1 + // the security log read
      1 + // a lead's table of its sub-ferrets (`GET /v1/sessions/:sessionId/subtree`, docs/pack-mode.md)
      5 + // the passkey step-up: this device's passkeys, registration and step-up, each with its options (the owner's re-opened window is admin-token)
      1 + // "Send now" for the answers a ferret's outbox holds (docs/agenda.md § The loop)
      1 + // the owner's "Clear all from agent ferrets": every open item on the agent ferrets' boards, dismissed (docs/agenda.md)
      1 + // one device's own grants, changed (B5)
      2 + // the machine's security settings: the read and the change (zero-trust B6)
      1 + // switching the tunnel on or off (pairing.configure); its read is `authenticated`, like the carrier refresh
      2 + // the unlock: its options and the verified unlock (zero-trust B6)
      1 + // the Console's input: typing into a session's own pane, governed as `terminal.use`
      1 + // the permission prompt's answer: a digit or Escape into the same pane, governed the same way
      1 + // a harness dialog's answer (hooks review, an update, a sign-in): arrows then Enter into the same pane, governed the same way
      1 + // an agent's rename: a new first name or task title
      2 + // pinning an agent to the top of the sidebar, and unpinning it (docs/grants.md)
      1 + // a ferret's hypermedia switch, from its next launch (docs/hypermedia.md)
      2 + // a ferret's agenda mode: its read and its switch, from its next launch (docs/notifications.md)
      2 + // a ferret's compaction trigger: its read and its change, from its next launch (docs/compact-at.md)
      5 + // Pack mode: its view, recommend, a sub-ferret start, a result and a ferret's switch (docs/pack-mode.md)
      5 + // the routing prompt's Clean up: the inventory, a clean-up start and its run, accept and undo
      5 + // adding an MCP server for one ferret: its listing, and a preview and an add for each of the project and the login
      6 + // a person's agent tools: terminal and browser tool calls, their control changes, and each kind's control read
      2 + // the speed-up keys: their status read and one provider's Test
      2 + // the browser: its machine-wide state read and the owner-only proxy Test
      3 + // updating this daemon: the view, starting an update, and the automatic-install setting (docs/updating.md)
      2 + // updating the agent CLIs: their view (which is when npm is asked) and starting one update
      4 + // the configuration files: status, one file, an edit and a confirmation (the agent's door is `none`)
      1 + // an owner's request for a Warden investigation (the "who needs you" feed is `authenticated`, like the status)
      1 + // the owner leaving a ferret alone for longer than the Warden would
      3 + // restarting the ferrets with out-of-date instructions: the restart, the status and clearing the queue (docs/launch-settings.md)
      1 + // a Restart's stale-settings read: would a relaunch change what this session runs on
      1 + // a cross-harness move's preview: what converting the conversation would carry (docs/migration-cross-harness.md)
      1 + // a refused migration's remedy: ask the agent to stop its own background jobs (docs/ferret-messages.md)
      3 + // existing conversations kept as ferrets: the listing, one conversation's preview and the adoption
      3 + // the model catalogs: the list, a check for a newer published one, and a read of the models Ollama has installed (docs/model-catalog.md)
      9 + // lessons: the default's write, Apply's preview and write, the per-ferret switch and its list, and the scan's estimate, start, read and cancel (a ferret's own door is `none`)
      2 + // the performance profile: start one, and read it back by id (`fy daemon profile`)
      1 + // one transcript image by its handle: the log's `[fy-image …]` marker, governed exactly like `logs` (docs/grants.md)
      1 + // one page of the chat's transcript, the tail or the page before a byte, governed exactly like `logs` (docs/grants.md)
      1 + // a search of the chat's whole transcript, scrubbed like `logs` and governed exactly like it (docs/grants.md)
      1 + // handing a web address to this computer's own browser (loopback caller only)
      3 + // the skills inventory: the machine listing, one session's listing, and the Open read of a listed SKILL.md
      3 + // a ferret's processes: the list, one process's output, and Stop
      5 + // the board's projects: the list, one project's lanes, a propose, edit or confirm of them, and its switch read and set
      7 + // the owner's input requests: the two lists, a page request's picture, deliver or cancel one, and the quarantine list and its end (docs/input-requests.md)
      13 + // accounts and sign-ins: the list, the hint, look-alike, an account’s put, rename, delete, merge and apart, a sign-in’s add, put, delete and recipe answer, and the owner’s default account for a place (docs/secrets.md)
      9 + // 2FA keys: add, relabel and remove one, and a seed’s stage, read (by account, or by the stage alone), passkey-bound commit, confirm-in-app and drop (docs/secrets.md)
      3 + // approving a sign-in on the phone: the list, one approval, and "Not me" (docs/input-requests.md)
      16 + // secure copy: a session's copies, the rules (list, the old one-step add that now makes nothing, remove, settings read and change), a paste rule's stage, profile targets' stage and its passkey-bound commit, the waiting stages, a stage's read, a device taking a machine stage, a rule's passkey-bound commit and drop (owner decision !A244, secrev-1334), the paste plans and an answer to one (docs/secure-copy.md)
      8 + // task plans: the list, one plan, a selection's stage, read, passkey-bound commit, confirm-in-app and drop, and revoke (docs/secure-copy.md)
      13 + // standing sign-in rules: the ferrets' suggestions (read and dismiss, memory only), the list, eligibility, a stage, its read, confirm-in-app, a device taking a machine stage, the kept-proof commit and drop, narrow, revoke one and revoke an account's (docs/secrets.md)
      2 + // the board's legacy import: the old-reference lookup, and the one-time import (owner only)
      9 + // installing a catalog item from a signed file: a preview and an apply per scope, the list, a remove per scope, and stay or skip per scope (docs/catalogs.md)
      7 + // copying a skill from this machine into a project or runtime: a preview and an apply per scope, the list, and a remove per scope (docs/catalogs.md)
      19 + // the catalogs this machine publishes: list, the items across them, make, change, delete, preview, add, publish, withdraw, one-tap Add and its Undo, export, and the item routes: one item, one version, what changed, the preview and publish of an update, making a version current and retiring one (docs/catalogs.md)
      10 + // the people a catalog is shared with: mint, list and end a share, approve a new passkey for an invite; list, rename, revoke a member, remove a browser or a catalog (docs/catalogs.md)
      9 + // the download links this machine makes: the store's status, a preview, list, mint, one link, move, change, Copy and turn off (docs/catalogs.md § Links)
      1 + // this daemon's own id for the owner's CLI links (`GET /v1/pair/identity`, person only)
      3 + // the shared draft: the owner's unsent composer, read, edited and streamed live to any of their own devices (&F331)
      3 + // the saved pictures: a ferret's or the owner's save, a picture's meta, and its payload (docs/renders.md)
      1 + // the roll-up of every conversation's open and parked agenda items, paged (`GET /v1/agenda/open`, docs/agenda.md)
      1; // the older finished sessions the archive took out of the live list (`GET /v1/archived-sessions`, docs/session-archive.md)
    // `none` lost `POST /v1/pair`: redemption happens only inside a session now, so it is no route at all.
    // `authenticated` gained the Warden's "who needs you" feed, which a live warden reads like its status,
    // and the WebRTC offer: any paired device may ask for a shorter path to its own daemon (§16).
    // It gained the tunnel read too: whether a machine has a tunnel is not a secret (§15).
    should(minima).deepEqual({ none: 7, authenticated: 10, operator: operatorRoutes, 'admin-token': 1 });
    should(
      canonical(routes.filter(route => route.privilegedOnly === true).map(route => `${route.method} ${route.path}`)),
    ).deepEqual(
      canonical([
        'POST /v1/agent/config',
        'POST /v1/system/open-url',
        'POST /v1/agent/tools',
        'POST /v1/agent/lessons',
        'GET /v1/sessions/:sessionId/attach',
      ]),
    );
  });

  it('should serve the base feeds and every mounted subsystem from one table', () => {
    // Arrange / Act
    const routes = mountedDaemonRoutes(base, subsystems()).map(route => `${route.method} ${route.path}`);

    // Assert
    should(canonical(routes)).deepEqual(
      canonical([
        'GET /healthz',
        'GET /usage',
        'GET /v1/usage',
        'GET /metrics',
        'POST /v1/pair/code',
        'GET /v1/pair/code/:pairingId',
        'DELETE /v1/pair/code/:pairingId',
        // This daemon's own id (the owner's CLI puts it in a link), then who may reach this machine, and one entry's
        // removal. NOTE WHAT IS ABSENT: there is no route that returns a device token or its digest — the list is a
        // projection with no field for one.
        'GET /v1/pair/identity',
        'GET /v1/pair/devices',
        'DELETE /v1/pair/devices/:deviceId',
        // One device's own grants (B5): widen at the machine, or from a device holding what it grants.
        'PATCH /v1/pair/devices/:deviceId/grants',
        // An agenda item the owner opened: its alerts come down on their other devices (names no device, returns none).
        'POST /v1/push/seen',
        // Which browsers this daemon may WAKE. NOTE WHAT IS ABSENT: no route returns a push endpoint or
        // its key halves — that triple is a bearer capability to buzz somebody's phone, and the enrolment
        // list is a projection with no field for one.
        'GET /v1/push/vapid',
        'GET /v1/push/subscriptions',
        'POST /v1/push/subscriptions',
        'DELETE /v1/push/subscriptions/:pushId',
        // The passkey step-up. NOTE WHAT IS ABSENT: no route returns a challenge after it is issued, a
        // public key or a held step-up — the daemon remembers the step-up, and the browser holds nothing.
        'GET /v1/passkeys',
        'POST /v1/passkeys/options',
        'POST /v1/passkeys',
        'POST /v1/step-up/options',
        'POST /v1/step-up',
        // A confirmation on opening (zero-trust B6).
        'POST /v1/unlock/options',
        'POST /v1/unlock',
        // The owner's recovery path: a browser is never at the machine (B4), so only `fy passkey window`
        // can re-open a device's passkey window. Without it a device past its first window is locked out.
        'POST /v1/passkeys/registration-window',
        // The machine's security settings the step-up and presence are tuned by (zero-trust B6).
        'GET /v1/security',
        'PATCH /v1/security',
        // The grant surface. NOTE WHAT IS ABSENT: there is no password to set and nothing to unlock — a
        // governed change is held behind the passkey step-up, so these three are the whole surface.
        'GET /v1/grants',
        'GET /v1/grants/audit',
        'PATCH /v1/grants',
        'GET /v1/audit',
        // The carrier refresh, beside the pairing exchange whose second half it is. NOTE WHAT IS ABSENT:
        // there is no POST, PUT or DELETE here — a device may read where this daemon can be reached and
        // can never re-point it, because that is a change to the operator's own document.
        'GET /v1/carriers',
        // The tunnel switch: whether this machine runs one, and on or off without a restart. NOTE WHAT IS
        // ABSENT: no address in either direction — a device may switch the tunnel, never re-point it.
        'GET /v1/tunnel',
        'PUT /v1/tunnel',
        // The peer-to-peer carrier's signalling, asked for inside a session that already reached the daemon.
        'POST /v1/webrtc/offer',
        'GET /v1/health',
        'GET /v1/doctor',
        'POST /v1/diagnostics/profile',
        'GET /v1/diagnostics/profile/:id',
        // The account model's credentials (docs/design/account-model.md §7). NOTE WHAT IS ABSENT: no
        // route returns a token, a refresh token or a digest — only status and usage — and there is no
        // sign-out or label route, because both are reviewed changes.
        'GET /v1/fleet/credentials',
        'POST /v1/fleet/credentials/:credentialId/check',
        // Environment logins: the preset catalogue a login is made from, and a login's Test, which spends
        // its key once through the outbound holder and answers a code — never the key, never the reply.
        'POST /v1/fleet/credentials/:credentialId/test',
        'GET /v1/fleet/presets',
        // The account model's catalogue and its reviewed changes. Every write is a staged change and its
        // explicit apply; there is no route that edits the configuration directly.
        'GET /v1/fleet/machine',
        'GET /v1/fleet/components',
        'GET /v1/fleet/profiles',
        'POST /v1/fleet/profiles/preview',
        'GET /v1/fleet/runtimes',
        'POST /v1/fleet/proposals',
        'GET /v1/fleet/proposals/:proposalId',
        'POST /v1/fleet/proposals/:proposalId/apply',
        // A machine's setup. The import and the clone are reviewed changes above; these are the scan they
        // start from, the export a clone carries, and the tool install.
        'GET /v1/fleet/setup/scan',
        'POST /v1/fleet/machine/tools/install',
        'GET /v1/fleet/export',
        'POST /v1/fleet/clone/review',
        'POST /v1/fleet/clone/forget',
        'POST /v1/fleet/clone/keys',
        // Driving a harness’s own sign-in. NOTE WHAT IS ABSENT: no route here accepts or returns a
        // provider token. Two values go out — a verification URL, and for Codex a device code — and one
        // short-lived authorization code comes in, straight to the harness child’s stdin. Every route here is
        // `fleet.configure`, because the risk is login substitution rather than disclosure.
        'POST /v1/fleet/login',
        'GET /v1/fleet/login/:flowId',
        'POST /v1/fleet/login/:flowId',
        'DELETE /v1/fleet/login/:flowId',
        // Signing in to a remote MCP server (docs/mcp-oauth.md). NOTE WHAT IS ABSENT: no route returns a
        // token. The daemon is the OAuth client and files them in the secret store; an authorization URL goes
        // out and one callback address comes in, in a body.
        'GET /v1/fleet/mcp-auth',
        'POST /v1/fleet/mcp-auth/:component',
        'DELETE /v1/fleet/mcp-auth/:component',
        'POST /v1/fleet/mcp-auth/flows/:flowId',
        'DELETE /v1/fleet/mcp-auth/flows/:flowId',
        'GET /v1/mcp',
        'POST /v1/mcp/check',
        'GET /v1/sessions/:sessionId/mcp/servers',
        // Resource limits, beside the fleet they bound. NOTE WHAT IS ABSENT: there is no POST and no
        // DELETE — an operator narrows or widens one saved document, and nothing here creates or
        // destroys a slice, because the units are transient and belong to the launches that made them.
        'GET /v1/cgroups/config',
        // The configuration files (docs/config-files.md): what is in effect, one file, an edit and the owner's
        // confirmation of one that loosens. NOTE WHAT IS ABSENT: no route deletes a file or edits the accepted
        // record, and an agent's own door is the privileged `POST /v1/agent/config` below.
        'GET /v1/config/status',
        'GET /v1/config/file',
        'PUT /v1/config/file',
        'POST /v1/config/confirm',
        'POST /v1/agent/config',
        // Imported harness history is deliberately not a session route: it can be read but has no
        // daemon journal, lifecycle, pane, or resume/send control.
        'GET /v1/imports/history',
        'GET /v1/imports/history/:importId',
        // Existing conversations kept as ferrets: listed and searched, then adopted into sessions that
        // RESUME them, with the last few exchanges of one on request. All are fleet.configure; none
        // returns a whole transcript or a file path.
        'GET /v1/imports/conversations',
        'GET /v1/imports/conversations/:harness/:conversationId/preview',
        'POST /v1/imports/conversations/adopt',
        'GET /v1/gc',
        'POST /v1/gc',
        // Handing a web address to the OS opener. Operator + privileged arrival: a remote caller is refused.
        'POST /v1/system/open-url',
        // The secret store. NOTE WHAT IS ABSENT: there is no `GET /v1/secrets/:name`, and this list is
        // the proof of it — no route returns a secret value. `use` is how a value is spent instead.
        'GET /v1/secrets',
        'POST /v1/secrets/use',
        'POST /v1/secrets',
        'DELETE /v1/secrets/:name',
        // Copying to another machine: an offer, ciphertext only the target opens, and the names filed.
        'POST /v1/secrets/imports',
        'POST /v1/secrets/imports/:importId',
        'POST /v1/secrets/exports/:importId',
        // Accounts: names, labels and flags out; values only ever in.
        'GET /v1/accounts',
        'GET /v1/accounts/hint',
        'GET /v1/accounts/look-alike',
        'PUT /v1/accounts/sign-ins/:signIn',
        'DELETE /v1/accounts/sign-ins/:signIn',
        'POST /v1/accounts/sign-ins/:signIn/recipe/proposals/:proposalId',
        'PUT /v1/accounts/defaults',
        'PUT /v1/accounts/:id',
        'POST /v1/accounts/:id/rename',
        'DELETE /v1/accounts/:id',
        'POST /v1/accounts/:id/sign-ins',
        'POST /v1/accounts/:id/merge',
        'POST /v1/accounts/:id/apart',
        // 2FA keys: a seed is staged, then saved only with a passkey bound to its stage; nothing answers one.
        'POST /v1/accounts/:id/factors/seed',
        'GET /v1/accounts/seed-stages/:stage',
        'GET /v1/accounts/:id/factors/seed/:stage',
        'POST /v1/accounts/:id/factors/seed/:stage/commit',
        'POST /v1/accounts/:id/factors/seed/:stage/confirm-in-app',
        'DELETE /v1/accounts/:id/factors/seed/:stage',
        'POST /v1/accounts/:id/factors',
        'PATCH /v1/accounts/:id/factors/:factor',
        'DELETE /v1/accounts/:id/factors/:factor',
        // The catalogs this machine publishes (docs/catalogs.md): every one is `sharing`/`use`.
        'GET /v1/catalogs',
        'GET /v1/catalog-items',
        'GET /v1/catalog-items/:itemId',
        'GET /v1/catalog-items/:itemId/versions/:version',
        'GET /v1/catalog-items/:itemId/changes',
        'POST /v1/catalog-items/:itemId/versions/preview',
        'POST /v1/catalog-items/:itemId/versions',
        'PUT /v1/catalog-items/:itemId/current',
        'PATCH /v1/catalog-items/:itemId/versions/:version',
        'POST /v1/catalogs',
        'PATCH /v1/catalogs/:id',
        'DELETE /v1/catalogs/:id',
        'POST /v1/catalogs/:id/items/preview',
        'POST /v1/catalogs/:id/items',
        'POST /v1/catalogs/:id/items/:itemId/versions',
        'DELETE /v1/catalogs/:id/items/:itemId',
        'POST /v1/catalog-items/quick-add',
        'POST /v1/catalog-items/quick-add/undo',
        'POST /v1/catalogs/:id/export',
        'POST /v1/catalog-shares',
        'PUT /v1/catalog-shares/:shareId/new-passkey',
        'DELETE /v1/catalog-shares/:shareId/new-passkey',
        'GET /v1/catalog-shares',
        'DELETE /v1/catalog-shares/:shareId',
        'GET /v1/catalog-members',
        'PATCH /v1/catalog-members/:memberId',
        'DELETE /v1/catalog-members/:memberId',
        'DELETE /v1/catalog-members/:memberId/keys/:keyId',
        'DELETE /v1/catalog-members/:memberId/catalogs/:catalogId',
        'GET /v1/catalog-links/store',
        'POST /v1/catalog-links/preview',
        'GET /v1/catalog-links',
        'POST /v1/catalog-links',
        'GET /v1/catalog-links/:linkId',
        'PUT /v1/catalog-links/:linkId/version',
        'PATCH /v1/catalog-links/:linkId',
        'POST /v1/catalog-links/:linkId/copy',
        'DELETE /v1/catalog-links/:linkId',
        'GET /v1/sessions',
        'GET /v1/sessions/:sessionId',
        'GET /v1/archived-sessions',
        'GET /v1/projects',
        'POST /v1/projects',
        'GET /v1/sessions/:sessionId/skills',
        'GET /v1/sessions/:sessionId/skills/inventory',
        'GET /v1/skills',
        'GET /v1/skills/file',
        'GET /v1/board/projects',
        'GET /v1/board/projects/:projectId/lanes',
        'POST /v1/board/projects/:projectId/lanes',
        'GET /v1/board/projects/:projectId/switch',
        'PUT /v1/board/projects/:projectId/switch',
        'GET /v1/worktrees/removal',
        'POST /v1/worktrees/remove',
        'GET /v1/worktrees',
        'POST /v1/worktrees',
        'POST /v1/sessions',
        'POST /v1/sessions/:sessionId/stop',
        'GET /v1/sessions/by-request/:requestId',
        'POST /v1/sessions/:sessionId/revoke-credential',
        'POST /v1/sessions/:sessionId/resume',
        'GET /v1/sessions/:sessionId/relaunch-settings',
        'POST /v1/sessions/:sessionId/conversion-preview',
        'POST /v1/sessions/:sessionId/migrate',
        'POST /v1/sessions/:sessionId/migrate/ask-to-stop-jobs',
        'POST /v1/restarts',
        'GET /v1/restarts',
        'DELETE /v1/restarts',
        'POST /v1/sessions/:sessionId/handover',
        'GET /v1/sessions/:sessionId/handover',
        'POST /v1/sessions/:sessionId/handover/cancel',
        'POST /v1/sessions/:sessionId/fork',
        'GET /v1/sessions/:sessionId/runtime-models',
        'POST /v1/sessions/:sessionId/runtime',
        'POST /v1/sessions/:sessionId/signal',
        'POST /v1/sessions/:sessionId/rename',
        'POST /v1/sessions/:sessionId/pin',
        'POST /v1/sessions/:sessionId/unpin',
        'PATCH /v1/sessions/:sessionId/hypermedia',
        'GET /v1/sessions/:sessionId/agenda-mode',
        'PATCH /v1/sessions/:sessionId/agenda-mode',
        'GET /v1/sessions/:sessionId/compact-at',
        'PATCH /v1/sessions/:sessionId/compact-at',
        'GET /v1/pack',
        'GET /v1/pack/inventory',
        'POST /v1/pack/routing/clean-up',
        'GET /v1/pack/routing/jobs/:jobId',
        'POST /v1/pack/routing/accept',
        'POST /v1/pack/routing/undo',
        'POST /v1/pack/recommend',
        'POST /v1/pack/new',
        'GET /v1/sessions/:sessionId/result',
        'GET /v1/sessions/:sessionId/subtree',
        'PATCH /v1/sessions/:sessionId/pack',
        'POST /v1/sessions/:sessionId/mcp/project/preview',
        'POST /v1/sessions/:sessionId/mcp/login/preview',
        'POST /v1/sessions/:sessionId/mcp/project',
        'POST /v1/sessions/:sessionId/mcp/login',
        'GET /v1/sessions/:sessionId/mcp',
        'POST /v1/catalog-installs/project/preview',
        'POST /v1/catalog-installs/runtime/preview',
        'POST /v1/catalog-installs/project',
        'POST /v1/catalog-installs/runtime',
        'GET /v1/catalog-installs',
        'DELETE /v1/catalog-installs/project/:installId',
        'DELETE /v1/catalog-installs/runtime/:installId',
        'PATCH /v1/catalog-installs/project/:installId',
        'PATCH /v1/catalog-installs/runtime/:installId',
        'POST /v1/skill-installs/local/project/preview',
        'POST /v1/skill-installs/local/runtime/preview',
        'POST /v1/skill-installs/local/project',
        'POST /v1/skill-installs/local/runtime',
        'GET /v1/skill-installs/local',
        'DELETE /v1/skill-installs/local/project/:installId',
        'DELETE /v1/skill-installs/local/runtime/:installId',
        'POST /v1/sessions/:sessionId/send',
        'POST /v1/sessions/:sessionId/interrupt',
        'GET /v1/sessions/:sessionId/sends',
        'GET /v1/sessions/:sessionId/queue',
        'PATCH /v1/sessions/:sessionId/queue/:messageId',
        'DELETE /v1/sessions/:sessionId/queue/:messageId',
        'GET /v1/sessions/:sessionId/sends/:sendId',
        'GET /v1/sessions/:sessionId/handoffs/:name',
        'POST /v1/sessions/:sessionId/sends/:sendId/retry',
        'POST /v1/sessions/:sessionId/sends/:sendId/cancel',
        'POST /v1/sessions/:sessionId/sends/:sendId/enter',
        'POST /v1/sessions/:sessionId/composer',
        'POST /v1/sessions/:sessionId/answer',
        'POST /v1/sessions/:sessionId/attachments',
        'GET /v1/sessions/:sessionId/attachments/:attachmentId',
        'POST /v1/sessions/:sessionId/attachments/:attachmentId/unlock',
        'DELETE /v1/sessions/:sessionId/attachments/:attachmentId/unlock',
        'GET /v1/sessions/:sessionId/agenda',
        'GET /v1/sessions/:sessionId/agenda/:id',
        'POST /v1/sessions/:sessionId/agenda',
        'GET /v1/sessions/:sessionId/agenda/:id/conversation',
        'GET /v1/sessions/:sessionId/agenda/:id/versions',
        'GET /v1/sessions/:sessionId/agenda/:id/versions/:version',
        'PUT /v1/sessions/:sessionId/agenda/:id/seen',
        'POST /v1/sessions/:sessionId/agenda/replies',
        'POST /v1/agenda/clear-agents',
        'GET /v1/agenda/open',
        'GET /v1/machine/agenda',
        'GET /v1/machine/agenda/:id',
        'POST /v1/machine/agenda',
        'GET /v1/sessions/:sessionId/pins',
        'POST /v1/sessions/:sessionId/pins',
        'POST /v1/renders',
        'GET /v1/renders/:id/meta',
        'GET /v1/renders/:id',
        'GET /v1/sessions/:sessionId/shared-draft',
        'POST /v1/sessions/:sessionId/shared-draft',
        'GET /v1/tasks',
        'GET /v1/sessions/:sessionId/tasks',
        'GET /v1/board',
        'GET /v1/board/ids',
        'GET /v1/board/merge-gate',
        'POST /v1/board/tasks',
        'POST /v1/board/skip',
        'GET /v1/board/tasks',
        'POST /v1/board/import',
        'GET /v1/board/tasks/:taskId',
        'POST /v1/board/tasks/:taskId',
        'POST /v1/board/tasks/:taskId/start',
        'GET /v1/search',
        'POST /v1/search/related',
        'POST /v1/tidy/plan',
        'GET /v1/analytics',
        'GET /v1/analytics/pricing',
        'PATCH /v1/analytics/pricing',
        'POST /v1/analytics/pricing/sync/preview',
        'POST /v1/analytics/pricing/sync/apply',
        // The agent tools. The agent's own route names no session: its session is the credential it
        // presents. A person's live under `…/surfaces`, where nothing else can shadow them.
        'POST /v1/agent/tools',
        'POST /v1/sessions/:sessionId/surfaces/terminals/tools',
        'POST /v1/sessions/:sessionId/surfaces/terminals/control',
        'GET /v1/sessions/:sessionId/surfaces/terminals/control',
        'POST /v1/sessions/:sessionId/surfaces/browser/tools',
        'POST /v1/sessions/:sessionId/surfaces/browser/control',
        'GET /v1/sessions/:sessionId/surfaces/browser/control',
        // The owner's input requests: the lists, then deliver and cancel (the agent raises through its own tools route).
        'GET /v1/input-requests',
        'GET /v1/sessions/:sessionId/input-requests',
        'GET /v1/sessions/:sessionId/input-requests/:requestId/shot',
        'POST /v1/sessions/:sessionId/input-requests/:requestId/deliver',
        'GET /v1/sessions/:sessionId/input-quarantines',
        'POST /v1/sessions/:sessionId/input-quarantines/:key/end',
        'POST /v1/sessions/:sessionId/input-requests/:requestId/cancel',
        // Approving a sign-in on the phone: read the cards, and "Not me" (no route sets one moved-on).
        'GET /v1/phone-approvals',
        'GET /v1/sessions/:sessionId/phone-approvals/:approvalId',
        'POST /v1/sessions/:sessionId/phone-approvals/:approvalId/refuse',
        // Secure copy: a session's copies by description, the owner's pre-approval rules and the ferrets' paste plans.
        'GET /v1/sessions/:sessionId/copies',
        'GET /v1/copy-rules',
        'GET /v1/copy-rules/settings',
        'PUT /v1/copy-rules/settings',
        'POST /v1/copy-rules/settings/stages',
        'POST /v1/copy-rules/settings/stages/:stage/commit',
        'POST /v1/copy-rules',
        'POST /v1/copy-rules/stages',
        'GET /v1/copy-rules/stages',
        'GET /v1/copy-rules/stages/:stage',
        'POST /v1/copy-rules/stages/:stage/commit',
        'POST /v1/copy-rules/stages/:stage/bind',
        'DELETE /v1/copy-rules/stages/:stage',
        'DELETE /v1/copy-rules/:ruleId',
        'GET /v1/copy-plans',
        'POST /v1/sessions/:sessionId/copy-plans/:planId/approve',
        // Task plans: read them, stage a selection (a sign-in needs its passkey to commit), confirm it in the app, revoke.
        'GET /v1/task-plans',
        'GET /v1/sessions/:sessionId/task-plans/:planId',
        'POST /v1/sessions/:sessionId/task-plans/:planId/approval',
        'GET /v1/sessions/:sessionId/task-plans/:planId/approval/:stage',
        'POST /v1/sessions/:sessionId/task-plans/:planId/approval/:stage/commit',
        'POST /v1/sessions/:sessionId/task-plans/:planId/approval/:stage/confirm-in-app',
        'DELETE /v1/sessions/:sessionId/task-plans/:planId/approval/:stage',
        'POST /v1/sessions/:sessionId/task-plans/:planId/revoke',
        // Standing sign-in rules: read them, stage one (it commits only with a passkey over its bytes), narrow, revoke.
        'GET /v1/sign-in-rules/suggestions',
        'DELETE /v1/sign-in-rules/suggestions/:sid',
        'GET /v1/sign-in-rules',
        'GET /v1/sign-in-rules/eligibility',
        'POST /v1/sign-in-rules/stages',
        'GET /v1/sign-in-rules/stages/:stage',
        'POST /v1/sign-in-rules/stages/:stage/confirm-in-app',
        'POST /v1/sign-in-rules/stages/:stage/bind',
        'POST /v1/sign-in-rules/stages/:stage/commit',
        'DELETE /v1/sign-in-rules/stages/:stage',
        'POST /v1/sign-in-rules/:id/narrow',
        'DELETE /v1/sign-in-rules/:id',
        'POST /v1/accounts/:id/sign-in-rules/revoke',
        'GET /v1/terminals',
        'POST /v1/terminals/close-finished',
        'GET /v1/sessions/:sessionId/terminals',
        'POST /v1/sessions/:sessionId/terminals',
        'GET /v1/sessions/:sessionId/terminals/:terminalId',
        'PATCH /v1/sessions/:sessionId/terminals/:terminalId',
        'DELETE /v1/sessions/:sessionId/terminals/:terminalId',
        // The human login window, and the per-session automation that is now genuinely served: the
        // browser session runtime composes the worker and its transport into a production
        // `BrowserViewerHost`, so the read and the action are real; its viewer opens inside a session.
        'GET /v1/browser/login',
        'POST /v1/browser/login',
        'GET /v1/sessions/:sessionId/browser',
        'POST /v1/sessions/:sessionId/browser',
        'GET /v1/browser/state',
        'POST /v1/browser/proxy/test',
        'GET /v1/names',
        'GET /v1/learning/status',
        'GET /v1/learning/config',
        'GET /v1/learning/proposals',
        'POST /v1/learning/proposals/:id',
        'GET /v1/learning/proposals/:id/patch',
        'POST /v1/learning/run',
        'PATCH /v1/learning/config',
        'GET /v1/learning/proposals/:id/apply-preview',
        'POST /v1/learning/proposals/:id/apply',
        'GET /v1/learning/sessions',
        'PATCH /v1/sessions/:sessionId/learning',
        'POST /v1/learning/scan/estimate',
        'POST /v1/learning/scan/cancel',
        'GET /v1/learning/scan',
        'POST /v1/learning/scan',
        'POST /v1/agent/lessons',
        'POST /v1/recommend',
        // Dictation enhancement: the daemon's one remaining speech-to-text route, and a fixed literal
        // under a prefix no other subsystem uses. Recognition happens in the browser.
        'POST /v1/stt/enhance',
        // Speed-up keys: which are set (by name), and a Test that spends one once. No key on either.
        'GET /v1/speedups',
        'POST /v1/speedups/:provider/test',
        // The model catalogs: the list, a check for a newer published catalog, and a read of the models Ollama
        // has installed on this machine. Fixed literals, no other user.
        'GET /v1/models',
        'POST /v1/models/refresh',
        'POST /v1/models/local/refresh',
        // Updating this daemon: the view, starting an update, and the automatic-install setting.
        'GET /v1/daemon/update',
        'POST /v1/daemon/update',
        'PATCH /v1/daemon/update/settings',
        // Updating the agent CLIs: the view, and starting one harness's update.
        'GET /v1/harnesses/update',
        'POST /v1/harnesses/update',
        // The working-tree read. Its four deeper paths come before the one-segment `fs`, which is what
        // keeps `fs/file` reachable at all: the router matches in registration order.
        'GET /v1/sessions/:sessionId/fs/file',
        'GET /v1/sessions/:sessionId/fs/index',
        'GET /v1/sessions/:sessionId/fs/changes',
        'GET /v1/sessions/:sessionId/fs/diff',
        'GET /v1/sessions/:sessionId/fs',
        // Fleet supervision. Every path is under `/v1/warden`, which no other subsystem uses, and the
        // subsystem also owns the sweep TIMER — a supervision loop with no route would be invisible to
        // the reachability gate, which is how a background subsystem ships unmounted.
        'GET /v1/warden/status',
        'GET /v1/warden/verdicts',
        'GET /v1/warden/report',
        'POST /v1/warden/run',
        'GET /v1/warden/agenda',
        'POST /v1/warden/investigate',
        'POST /v1/warden/leave',
        'GET /v1/warden/config',
        'PATCH /v1/warden/config',
        // The operator reads: the history the daemon recorded, the screen the agent is looking at, and
        // the transcript it wrote. Every one of these answered `unknown_route` while the protocol
        // client carried a method for it — see the mount's own header.
        'GET /v1/sessions/:sessionId/events',
        'GET /v1/sessions/:sessionId/snapshot',
        'GET /v1/sessions/:sessionId/logs',
        'GET /v1/sessions/:sessionId/log-page',
        'GET /v1/sessions/:sessionId/log-search',
        'GET /v1/sessions/:sessionId/messages',
        'GET /v1/sessions/:sessionId/transcript-images/:handle',
        // The attach proof. It sits with the operator reads but authorizes a local process action
        // rather than answering a question, which is why it is its own mount and its own literal.
        'GET /v1/sessions/:sessionId/attach',
        'POST /v1/sessions/:sessionId/console/input',
        'GET /v1/sessions/:sessionId/processes',
        'GET /v1/sessions/:sessionId/processes/:processId/output',
        'POST /v1/sessions/:sessionId/processes/:processId/stop',
        'POST /v1/sessions/:sessionId/permission',
        'POST /v1/sessions/:sessionId/dialog',
      ]),
    );
  });

  it('should never let a subsystem pattern shadow a base feed', () => {
    // The base feeds are fixed literal paths, so registration order cannot hide one behind a
    // parameterised subsystem route. Asserting it here means a future mount cannot break liveness.
    // Arrange
    const routes = mountedDaemonRoutes(base, subsystems());

    // Act
    const firstLiteral = routes.findIndex(route => route.path === '/healthz');
    const firstPattern = routes.findIndex(route => route.path.includes(':'));

    // Assert
    should(firstLiteral).be.below(firstPattern);
  });

  it('should let only the agenda’s answer routes consult the grants without a demand, so a new one is a reviewed diff', () => {
    // `consultsGrants` hands a handler the caller's grant standing on a route that demands nothing. It decides
    // nothing itself, but a ferret's own credential reads `governed: false`, so a handler that relaxed on that
    // without also asking `isAgentCaller` would serve a ferret. Each route that sets it is listed here.
    // Arrange
    const routes = mountedDaemonRoutes(base, subsystems());

    // Act
    const consulting = routes
      .filter(route => route.consultsGrants === true)
      .map(route => `${route.method} ${route.path}`);

    // Assert — an answer to a card that confirms a held configuration change (docs/agenda.md), and a paired device
    // bringing back a cut-off ferret (fleet.configure, secrev-1329b M2; a ferret is refused before it is read).
    should(consulting.toSorted()).eql(['POST /v1/sessions/:sessionId/agenda', 'POST /v1/sessions/:sessionId/resume']);
    should(routes.filter(route => route.consultsGrants === true && route.capability !== undefined)).eql([]);
  });

  it('should compress only the audited GET routes, so every other answer — and every new one — stays plain', () => {
    // BREACH: a compressed answer's length depends on its content, so an answer that can carry a secret, a
    // token, a digest of one, a pairing code or input-request material is never gzipped
    // (`lib/api/compression.ts`). Compression is OPT-IN: this is the whole set, so adding a route to it fails
    // here until its author has audited the body and listed it, and a route nobody audited is never compressed.
    // Arrange
    const routes = mountedDaemonRoutes(base, subsystems());

    // Act
    const compressed = routes
      .filter(route => route.method === 'GET' && route.compress === true)
      .map(route => route.path)
      .sort();

    // Assert — the fleet list, the board list and the board's id list: names, states, work text and launch-instruction hashes.
    should(compressed).eql(['/v1/board', '/v1/board/ids', '/v1/sessions']);
    should(routes.filter(route => route.method !== 'GET' && route.compress === true)).eql([]);
  });

  it("should keep the owner's draft from an agent through the whole mounted table, and serve it to their device", async () => {
    // Arrange — the real table: session addressing, agent control and the audit wrappers all in front.
    const mounted = subsystems();
    await mounted.grants.refresh();
    const drafts = builtSharedDraftsKnowing(['s1']);
    const dispatcher = createMountedDispatcher(base, mounted, [drafts]);
    const device = { deviceId: `fy_device_id_${'d'.repeat(22)}`, appSession: 'app-one' } as const;
    // The module mints a random generation per boot, so the edit names the one the first read answers with.
    const opened = jsonBody(await dispatcher.dispatch(request({ path: '/v1/sessions/s1/shared-draft', device }))) as {
      generation: string;
    };
    const edit = JSON.stringify({ generation: opened.generation, epoch: 0, base: 0, text: ['unsent words'] });

    // Act
    const written = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/sessions/s1/shared-draft', device, body: edit }),
    );
    const byDevice = await dispatcher.dispatch(request({ path: '/v1/sessions/Aniya/shared-draft', device }));
    const byAgent = await dispatcher.dispatch(
      request({ path: '/v1/sessions/s1/shared-draft', headers: agentIn('s1') }),
    );

    // Assert
    should(written.status).equal(200);
    should(jsonBody(byDevice)).match({ text: 'unsent words' });
    should(byAgent.status).equal(403);
    should(JSON.stringify(jsonBody(byAgent))).not.containEql('unsent');
    await drafts.provides.close();
  });

  it('should dispatch a base feed and a subsystem route through the same dispatcher', async () => {
    // Arrange
    // REFRESHED FIRST, exactly as the composition root does before it binds an address. A service
    // that has never read its document enforces `undetermined` — denied — on every governed route,
    // which is the correct fail-closed reading and not the state a serving daemon is ever in.
    const mounted = subsystems();
    await mounted.grants.refresh();
    const dispatcher = createMountedDispatcher(base, mounted);

    // Act
    const health = await dispatcher.dispatch(request({ path: '/healthz' }));
    const report = await dispatcher.dispatch(request({ path: '/v1/health', headers: human }));
    const doctor = await dispatcher.dispatch(request({ path: '/v1/doctor', headers: human }));
    const gc = await dispatcher.dispatch(request({ path: '/v1/gc', headers: human }));
    const sessions = await dispatcher.dispatch(request({ path: '/v1/sessions', headers: human }));
    const session = await dispatcher.dispatch(request({ path: '/v1/sessions/s1', headers: human }));
    // The same session by its agent's NAME, in any case: the table resolves it before the read runs.
    const named = await dispatcher.dispatch(request({ path: '/v1/sessions/Aniya', headers: human }));
    const projects = await dispatcher.dispatch(request({ path: '/v1/projects', headers: human }));
    const skills = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/skills', headers: human }));
    const pins = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/pins', headers: human }));
    const agenda = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/agenda', headers: human }));
    const analytics = await dispatcher.dispatch(request({ path: '/v1/analytics', headers: human }));
    const importedHistory = await dispatcher.dispatch(request({ path: '/v1/imports/history', headers: human }));
    const importedConversation = await dispatcher.dispatch(
      request({ path: '/v1/imports/history/imported-one', headers: human }),
    );
    const missingImportedConversation = await dispatcher.dispatch(
      request({ path: '/v1/imports/history/not-found', headers: human }),
    );
    // A terminal is a USE that a caller off this host may make only behind a live passkey step-up, so
    // the listing is asked from the host and the remote form is asked as well, refused by the grant.
    const terminals = await dispatcher.dispatch(
      request({ path: '/v1/sessions/s1/terminals', headers: human, loopback: true }),
    );
    const remoteTerminals = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/terminals', headers: human }));
    const learning = await dispatcher.dispatch(request({ path: '/v1/learning/status', headers: human }));
    // The login window, over the same dispatcher: the route `fy browser login` and the PWA's banner
    // have both spoken since they were ported, against a daemon that answered `unknown_route`. It is a
    // browser USE, so it is asked from the host.
    const login = await dispatcher.dispatch(request({ path: '/v1/browser/login', headers: human, loopback: true }));
    // The write half of the session surface, over the same dispatcher: a stop of a session the
    // fixture holds, which an unmounted route would answer as `unknown_route`.
    const stopped = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/sessions/s1/stop', headers: human, body: '{}' }),
    );
    // The revive, over the same dispatcher: the route the protocol client's `resume` speaks, which
    // answered `unknown_route` until the resume service was mounted behind it.
    const revived = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/sessions/s1/resume', headers: human, body: '{}' }),
    );
    // The migration, over the same dispatcher: the route the protocol client's `migrate` speaks,
    // which answered `unknown_route` while the safety gate that guards it sat constructed and
    // uncalled in the world.
    const migrated = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s1/migrate',
        // A migration names its logical request id, so a retried POST is one migration rather than
        // several destructive relaunches; the route refuses one that carries none.
        headers: { ...human, 'x-fy-request-id': 'surface-migration' },
        body: JSON.stringify({ agent: 'claude-auto-other' }),
      }),
    );

    // The three operator reads, over the same dispatcher: every one of them answered `unknown_route`
    // while the protocol client carried a method that spoke to it.
    const events = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/events', headers: human }));
    const screen = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/snapshot', headers: human }));
    const transcript = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/logs', headers: human }));
    // The attach proof, over the same dispatcher and against the REAL attach service: a tmux address
    // is only meaningful on the daemon's own host, so the mount demands loopback on top of `admin`.
    const attach = await dispatcher.dispatch(
      request({ path: '/v1/sessions/s1/attach', headers: human, loopback: true }),
    );
    const remoteAttach = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/attach', headers: human }));
    const importedHistoryBody = importedHistory.body;
    const importedConversationBody = importedConversation.body;

    // Assert
    should(health.status).equal(200);
    // The liveness probe and the scoped report are two different answers under one subject, and both
    // are reached: the daemon's own health is a mounted subsystem now, not a hardcoded literal.
    should(report.status).equal(200);
    should(doctor.status).equal(200);
    should(gc.status).equal(200);
    should(sessions.status).equal(200);
    // The id pattern is reached rather than shadowed by the deeper per-session routes below it.
    should(session.status).equal(200);
    should(named.status).equal(200);
    should(named.body).equal(session.body);
    should(projects.status).equal(200);
    should(skills.status).equal(200);
    // The session is unknown to this fixture, which still proves the route is mounted and reached.
    should(pins.status).equal(404);
    should(agenda.status).equal(200);
    should(analytics.status).equal(200);
    should(importedHistory.status).equal(200);
    should(importedConversation.status).equal(200);
    should(missingImportedConversation.status).equal(404);
    should(importedHistoryBody).containEql('"count":2');
    should(importedHistoryBody).not.containEql('/fixture/');
    should(importedConversationBody).containEql('record identifier');
    should(importedConversationBody).not.containEql('must not be exposed');
    should(terminals.status).equal(200);
    should(remoteTerminals.status).equal(403);
    should(remoteTerminals.body).containEql('grant_step_up_required');
    should(learning.status).equal(200);
    should(login.status).equal(200);
    should(stopped.status).equal(200);
    should(revived.status).equal(200);
    should(migrated.status).equal(200);
    should(events.status).equal(200);
    should(screen.status).equal(200);
    should(transcript.status).equal(200);
    should(attach.status).equal(200);
    should(remoteAttach.status).equal(403);
  });

  it('should validate the GC plan and force request before reaching the collector', async () => {
    // Arrange
    const limits: number[] = [];
    const forces: boolean[] = [];
    // The housekeeping module stands in with the same routes over a collector that records what reaches it.
    const collector = {
      id: 'housekeeping',
      provides: {},
      jobs: {},
      contributes: {
        routes: scratchGcRoutes({
          plan: async limit => {
            limits.push(limit);
            return [];
          },
          sweep: async force => {
            forces.push(force);
            return { sessions: 0, bytes: 0, failures: 0 };
          },
        }),
      },
    };
    const dispatcher = createMountedDispatcher(base, subsystems(), [collector]);

    // Act
    const planned = await dispatcher.dispatch(request({ path: '/v1/gc', query: [['limit', '7']], headers: human }));
    const forced = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/gc', headers: human, body: JSON.stringify({ force: true }) }),
    );
    const invalid = await dispatcher.dispatch(request({ path: '/v1/gc', query: [['limit', '0']], headers: human }));
    const unknown = await dispatcher.dispatch(request({ path: '/v1/gc', query: [['other', '1']], headers: human }));

    // Assert
    should([planned.status, forced.status, invalid.status, unknown.status]).deepEqual([200, 200, 400, 400]);
    should(limits).deepEqual([7]);
    should(forces).deepEqual([true]);
  });

  it('should serve every protocol-switching route from one table too', () => {
    // The same "is it mounted" assertion as above, for the surface that answers with a socket rather
    // than a body. A stream missing from here is a capability the product does not have, however
    // completely `TerminalStreamBridge` is built and tested.
    // Arrange / Act
    const routes = mountedSocketRoutes(subsystems()).map(route => `${route.method} ${route.path}`);

    // Assert — the same set, compared in canonical order (the dispatcher orders by specificity, not mount order).
    should(canonical(routes)).deepEqual(
      canonical([
        'GET /v1/events',
        'GET /v1/sessions/:sessionId/terminals/:terminalId/stream',
        'GET /v1/sessions/:sessionId/browser/stream',
        'GET /v1/sessions/:sessionId/shared-draft/stream',
      ]),
    );
  });

  it("should refuse every ferret the shared draft's live stream before the protocol switches, and open it for the owner", async () => {
    // Arrange
    const mounted = subsystems();
    await mounted.grants.refresh();
    const dispatcher = createMountedSocketDispatcher(base, mounted, [], [builtSharedDraftsKnowing(['s1'])]);
    const path = '/v1/sessions/s1/shared-draft/stream';
    const ferrets: readonly Record<string, string>[] = [
      { authorization: `Bearer ${PREFIXED_S1}` },
      { authorization: `Bearer ${CREDENTIALS.admin}`, 'x-ferretry-session-id': 's1', 'x-ferretry-client': 'cli' },
      { authorization: `Bearer ${CREDENTIALS.warden}` },
    ];

    // Act
    const refused = await Promise.all(
      ferrets.map(async headers => await dispatcher.upgrade(request({ path, headers }))),
    );
    const owner = await dispatcher.upgrade(request({ path, headers: human, loopback: true }));
    const bare = await dispatcher.upgrade(
      request({ path, headers: { authorization: `Bearer ${CREDENTIALS.admin}` }, loopback: true }),
    );

    // Assert
    // Every ferret is refused before the switch: a ferret's own credential already at authentication (401
    // on the socket table), the admin token naming a ferret's session and the warden as `owner_only` (403).
    should(refused.map(decision => decision.outcome)).deepEqual(['refused', 'refused', 'refused']);
    should(refused.slice(1).map(decision => (decision.outcome === 'refused' ? decision.response.status : 0))).deepEqual(
      [403, 403],
    );
    should(owner.outcome).equal('accepted');
    should(bare.outcome === 'refused' ? bare.response.status : 0).equal(403);
  });

  // THERE IS NO THIRD TABLE. A route that answered with the transport's own `Response` existed for
  // one subsystem only — the daemon's speech recognition, whose traffic was audio in and ranged model
  // files out. Recognition moved into the browser, and the seam went with it rather than staying as a
  // table with no members. The one surviving dictation route is JSON, and it is asserted above.

  it('should authorize a protocol switch over the same credentials as the HTTP surface', async () => {
    // Two dispatchers, one credential set. A socket dispatcher built from different credentials would
    // be a second, quieter authorization boundary, and the two would drift.
    // Arrange
    const mounted = subsystems();
    await mounted.grants.refresh();
    const dispatcher = createMountedSocketDispatcher(base, mounted);
    const path = '/v1/sessions/s1/terminals/0123456789ab/stream';

    // Act
    const anonymous = await dispatcher.upgrade(request({ path }));
    const authorized = await dispatcher.upgrade(request({ path, headers: human, loopback: true }));
    // A terminal socket from off this host is a terminal USE: held until the device steps up.
    const remote = await dispatcher.upgrade(request({ path, headers: human }));
    // The event feed, over the SAME socket dispatcher: an anonymous peer never holds it, and the
    // fleet form is accepted without naming a session at all.
    const anonymousEvents = await dispatcher.upgrade(request({ path: '/v1/events' }));
    const fleetEvents = await dispatcher.upgrade(request({ path: '/v1/events', headers: human }));

    // Assert
    should(anonymous.outcome === 'refused' ? anonymous.response.status : 0).equal(401);
    should(anonymousEvents.outcome === 'refused' ? anonymousEvents.response.status : 0).equal(401);
    should(fleetEvents.outcome).equal('accepted');
    // The terminal does not exist in this fixture, which still proves the route is mounted, reached,
    // and that existence is decided BEFORE any protocol switch.
    should(authorized.outcome === 'refused' ? authorized.response.status : 0).equal(404);
    should(remote.outcome === 'refused' ? remote.response.status : 0).equal(403);
  });

  it('should refuse a terminal SOCKET the operator has not granted', async () => {
    // THE HOLE THIS CLOSES. A socket table that skipped the grant check would have the daemon refuse
    // to CREATE a terminal an operator had denied and then hand a browser the socket that drives one.
    // Both tables go through the one authorization boundary, so there is one answer rather than two.
    // Arrange
    const mounted = {
      ...subsystems(),
      grants: grantSubsystem({ grants: { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: false } } }),
    };
    await mounted.grants.refresh();
    const sockets = createMountedSocketDispatcher(base, mounted);
    const http = createMountedDispatcher(base, mounted);
    const path = '/v1/sessions/s1/terminals/0123456789ab/stream';

    // Act — a caller that did NOT arrive over loopback, which is the only caller grants govern.
    const upgrade = await sockets.upgrade(request({ path, headers: human, loopback: false }));
    const created = await http.dispatch(
      request({ method: 'POST', path: '/v1/sessions/s1/terminals', headers: human, loopback: false }),
    );

    // Assert — the same refusal on both, and it names the next step rather than saying "forbidden".
    should(upgrade.outcome === 'refused' ? upgrade.response.status : 0).equal(403);
    should(created.status).equal(403);
    should(created.body).match(/has not granted the UI the use of session terminals/u);

    // And a LOOPBACK caller is unaffected: somebody at the machine already has the machine.
    const local = await sockets.upgrade(request({ path, headers: human, loopback: true }));
    should(local.outcome === 'refused' ? local.response.status : 0).equal(404);
  });
});

describe('the member sessions and the main table', () => {
  const member = {
    memberId: 'mbr_AAAAAAAAAAAAAAAAAAAAAA',
    keyId: 'mk_AAAAAAAAAAAAAAAAAAAAAA',
    appSession: 'app-1',
    sessionId: 's1',
  };
  const refuse = (): never => {
    throw new Error('a request without a member reached the member side');
  };
  const concrete = (path: string): string => path.replace(/[:*][A-Za-z]+/gu, 'x1');
  const never = async (): Promise<never> => {
    throw new Error('a request without a member reached the member side');
  };
  const memberTable = new MemberDispatcher({
    members: {
      ready: never,
      access: never,
      admitRedeem: refuse,
      commitRedeem: never,
      release: never,
      removeKey: never,
    },
    passkeys: {} as SharedRouteDeps['passkeys'],
    sessions: { spare: () => () => undefined },
    catalogs: {
      catalogs: never,
      signedManifest: never,
      versionsRevision: never,
      signedVersions: never,
      frozenItem: never,
    },
    publisher: () => ({ daemonId: '', daemonName: '', carriers: [] }),
    audit: { record: async () => undefined },
    now: () => 0,
  });

  it('should refuse a member on EVERY route of the main table, public ones and sockets included', async () => {
    // Arrange
    const mounted = subsystems();
    await mounted.grants.refresh();
    const http = createMountedDispatcher(base, mounted);
    const sockets = createMountedSocketDispatcher(base, mounted);
    const routes = mountedDaemonRoutes(base, mounted);
    const socketRoutes = mountedSocketRoutes(mounted);

    // Act
    const served = [];
    for (const route of routes) {
      const asked = {
        ...request({ method: route.method, path: concrete(route.path), headers: human, loopback: true }),
        member,
      };
      served.push({ route: `${route.method} ${route.path}`, response: await http.dispatch(asked) });
    }
    const upgrades = [];
    for (const route of socketRoutes) {
      const asked = { ...request({ path: concrete(route.path), headers: human, loopback: true }), member };
      upgrades.push({ route: `UPGRADE ${route.path}`, response: await sockets.upgrade(asked) });
    }

    // Assert — a sweep over a table that grew, not over a list written here.
    should(served.length).be.above(100);
    should(served.filter(entry => entry.response.status !== 403).map(entry => entry.route)).deepEqual([]);
    should(
      served
        .filter(entry => (JSON.parse(entry.response.body) as { code?: string }).code !== 'forbidden')
        .map(entry => entry.route),
    ).deepEqual([]);
    should(upgrades.length).be.above(0);
    should(
      upgrades
        .filter(entry => entry.response.outcome !== 'refused' || entry.response.response.status !== 403)
        .map(entry => entry.route),
    ).deepEqual([]);
  });

  it('should keep every member route out of the main table, and answer none of them to a device', async () => {
    // Arrange
    const mounted = subsystems();
    await mounted.grants.refresh();
    const http = createMountedDispatcher(base, mounted);
    const sockets = [...mountedSocketRoutes(mounted)];
    const mainPaths = [...mountedDaemonRoutes(base, mounted), ...sockets].map(route => route.path);
    const memberRoutes = memberTable.routes;

    // Act
    const asDevice = [];
    for (const route of memberRoutes) {
      asDevice.push(
        await http.dispatch(
          request({ method: route.method, path: concrete(route.path), headers: human, loopback: true }),
        ),
      );
    }
    const asNobody = [];
    for (const route of memberRoutes) {
      asNobody.push(
        await memberTable.dispatch(
          request({ method: route.method, path: concrete(route.path), headers: human, loopback: true }),
        ),
      );
    }

    // Assert — no pattern of the main table lives under /v1/shared, so the device credential finds nothing there…
    should(mainPaths.filter(path => path.startsWith('/v1/shared'))).deepEqual([]);
    should(asDevice.map(response => response.status)).deepEqual(memberRoutes.map(() => 404));
    // …and the member table, handed the device's request with its admin bearer, answers one 401 and reads nothing.
    should(memberRoutes.length).be.above(0);
    should(asNobody.map(response => response.status)).deepEqual(memberRoutes.map(() => 401));
  });
});

describe('who may call each route', () => {
  const concrete = (path: string): string => path.replace(/[:*][A-Za-z]+/gu, 'x1');
  /** A request whose body throws if anything reads it, so "refused before the body" is what is proved. */
  const unread = (route: { readonly method: string; readonly path: string }, headers: Record<string, string>) => ({
    ...request({ method: route.method, path: concrete(route.path), loopback: true, privilegedLoopback: true, headers }),
    text: async (): Promise<string> => {
      throw new Error(`${route.method} ${route.path} read its body`);
    },
  });
  const answer = (route: { readonly method: string; readonly path: string }, response: ApiResponse) => ({
    route: `${route.method} ${route.path}`,
    status: response.status,
    code: (JSON.parse(response.body) as { readonly code?: string }).code,
  });

  it('should declare who may call every route, so changing one is a reviewed diff', () => {
    // Arrange
    const mounted = subsystems();

    // Act
    const declared = [mountedDaemonRoutes(base, mounted), mountedSocketRoutes(mounted)].flatMap(routes =>
      routes.map(route => `${route.method} ${route.path} ${route.minimum} ${route.caller}`).sort(),
    );

    // Assert — the table is the concatenation of the per-module fragments (`tests/unit/modules/*/route-contract.ts`);
    // a route added, removed or reclassified changes its module's fragment. Canonical order: each table sorted by
    // `METHOD path`, sockets after requests, whatever order the fragments list their lines in.
    const socketKeys = new Set(mountedSocketRoutes(mounted).map(route => `${route.method} ${route.path}`));
    const isSocket = (line: string): boolean => socketKeys.has(line.split(' ').slice(0, 2).join(' '));
    should(declared).deepEqual([
      ...ROUTE_CALLERS.filter(line => !isSocket(line)).sort(),
      ...ROUTE_CALLERS.filter(isSocket).sort(),
    ]);
  });

  it('should put every mounted route in exactly one fragment, and name only mounted routes in a fragment', () => {
    // Arrange
    const mounted = subsystems();
    const keyOf = (line: string): string => line.split(' ').slice(0, 2).join(' ');
    const mountedKeys = [
      ...mountedDaemonRoutes(base, mounted).map(route => `${route.method} ${route.path}`),
      ...mountedSocketRoutes(mounted).map(route => `${route.method} ${route.path}`),
    ];
    const fragments = Object.entries(FRAGMENTS);

    // Act
    const owners = new Map(
      mountedKeys.map(key => [
        key,
        fragments.filter(([, f]) => f.callers.some(line => keyOf(line) === key)).map(([id]) => id),
      ]),
    );
    const unowned = mountedKeys.filter(key => owners.get(key)?.length !== 1);
    const unmounted = fragments.flatMap(([id, fragment]) =>
      [...fragment.callers.map(keyOf), ...Object.keys(fragment.notAudited)]
        .filter(key => !mountedKeys.includes(key))
        .map(key => `${id}: ${key}`),
    );
    // An excuse belongs to the fragment that owns the route it excuses, so a module's lines stay together.
    const strayExcuses = fragments.flatMap(([id, fragment]) =>
      Object.keys(fragment.notAudited)
        .filter(key => !fragment.callers.some(line => keyOf(line) === key))
        .map(key => `${id}: ${key}`),
    );
    const excuseKeys = fragments.flatMap(([, fragment]) => Object.keys(fragment.notAudited));

    // Assert
    should(unowned).eql([]);
    should(unmounted).eql([]);
    should(strayExcuses).eql([]);
    should(new Set(excuseKeys).size).equal(excuseKeys.length);
    should(Object.keys(NOT_AUDITED)).have.length(excuseKeys.length);
    should(ROUTE_CALLERS).have.length(fragments.reduce((sum, [, fragment]) => sum + fragment.callers.length, 0));
  });

  it('should leave no route out of the contract, an optional subsystem’s included', async () => {
    // Arrange — every `path: '…'` literal a route table in the daemon declares. A route behind an optional
    // subsystem the world above forgot to supply would be missing from the mounted table, and so from the
    // contract; this finds it from the source instead. The member table (`/v1/shared/*`) has its own key-based
    // authority and no `caller`.
    const sources = [
      ...new Bun.Glob('src/lib/runtime/mounts/*.ts').scanSync(DAEMON_ROOT),
      ...new Bun.Glob('src/lib/api/routes/*.ts').scanSync(DAEMON_ROOT),
    ];
    // A method beside its path is compared as the pair, so a new verb on a path the contract already lists
    // cannot slip through; a path written apart from its method is compared as a path.
    const routes = new Set<string>();
    const paths = new Set<string>();
    for (const source of sources) {
      const text = await Bun.file(`${DAEMON_ROOT}/${source}`).text();
      for (const found of text.matchAll(/method: '([A-Z]+)',\s*path: '(\/[^']+)'/gu))
        if (found[1] !== undefined && found[2] !== undefined) routes.add(`${found[1]} ${found[2]}`);
      for (const found of text.matchAll(/path: '(\/[^']+)'/gu)) if (found[1] !== undefined) paths.add(found[1]);
    }
    const contracted = [...ROUTE_CALLERS, ...OTHER_TABLE_CALLERS].map(line => line.split(' ').slice(0, 2).join(' '));
    const contractedPaths = new Set(contracted.map(route => route.split(' ')[1] ?? ''));
    const member = (route: string): boolean => route.includes(' /v1/shared/') || route.startsWith('/v1/shared/');

    // Act
    const missingRoutes = [...routes].filter(route => !contracted.includes(route) && !member(route));
    const missingPaths = [...paths].filter(path => !contractedPaths.has(path) && !member(path));

    // Assert
    should(routes.size).be.above(300);
    should(missingRoutes).deepEqual([]);
    should(missingPaths).deepEqual([]);
  });

  it('should refuse every caller that is a ferret on every person route, before any handler reads the body', async () => {
    // Arrange
    const mounted = subsystems();
    await mounted.grants.refresh();
    const dispatcher = createMountedDispatcher(base, mounted);
    const person = mountedDaemonRoutes(base, mounted).filter(route => route.caller === 'person');
    // Person sockets are in the contract too; the test above this one refuses ferrets on them.
    const personSockets = mountedSocketRoutes(mounted).filter(route => route.caller === 'person');
    // A ferret's own credential; the admin token naming a ferret's session (a pane from before the credential,
    // or an older fy); and a warden. All three are agents, and none reaches a person route.
    const ferrets: readonly Record<string, string>[] = [
      { authorization: `Bearer ${PREFIXED_S1}` },
      { authorization: `Bearer ${CREDENTIALS.admin}`, 'x-ferretry-session-id': 's1', 'x-ferretry-client': 'cli' },
      { authorization: `Bearer ${CREDENTIALS.warden}` },
    ];

    // Act
    const answers = [];
    for (const headers of ferrets)
      for (const route of person) answers.push(answer(route, await dispatcher.dispatch(unread(route, headers))));

    // Assert
    should(person.length + personSockets.length).equal(ROUTE_CALLERS.filter(line => line.endsWith(' person')).length);
    should(answers).deepEqual(
      ferrets.flatMap(() =>
        person.map(route => ({ route: `${route.method} ${route.path}`, status: 403, code: 'owner_only' })),
      ),
    );
  });

  it('should still serve a person on a person route: the owner at the machine is not refused as a ferret', async () => {
    // Arrange — the owner's CLI, no session: the route is reached, so its own answer (whatever it is) comes back.
    const mounted = subsystems();
    await mounted.grants.refresh();
    const dispatcher = createMountedDispatcher(base, mounted);
    const route = { method: 'PATCH', path: '/v1/grants' };

    // Act
    const response = await dispatcher.dispatch(
      request({
        ...route,
        loopback: true,
        privilegedLoopback: true,
        headers: { authorization: `Bearer ${CREDENTIALS.admin}`, 'x-ferretry-client': 'cli' },
        body: '{}',
      }),
    );

    // Assert
    should(answer(route, response).code).not.equal('owner_only');
  });

  it('should take a ferret’s own credential on an any route, as that ferret and never as the owner', async () => {
    // Arrange
    const mounted = subsystems();
    await mounted.grants.refresh();
    const dispatcher = createMountedDispatcher(base, mounted);

    // Act — a read every ferret makes (its session list), with no session header at all.
    const response = await dispatcher.dispatch(
      request({
        method: 'GET',
        path: '/v1/sessions',
        loopback: true,
        privilegedLoopback: true,
        headers: { authorization: `Bearer ${PREFIXED_S1}` },
      }),
    );

    // Assert
    should(response.status).equal(200);
  });

  it('should never look up a ferret’s credential that did not arrive on this machine’s own carrier', async () => {
    // Arrange
    const mounted = subsystems();
    await mounted.grants.refresh();
    const dispatcher = createMountedDispatcher(base, mounted);

    // Act — the same credential, from a remote carrier: a stranger's bearer.
    const response = await dispatcher.dispatch(
      request({ method: 'GET', path: '/v1/sessions', headers: { authorization: `Bearer ${PREFIXED_S1}` } }),
    );

    // Assert
    should(response.status).equal(401);
  });
});

describe('the audited surface', () => {
  const routes = mountedDaemonRoutes(base, subsystems()).map(route => `${route.method} ${route.path}`);
  const sockets = mountedSocketRoutes(subsystems()).map(route => `${route.method} ${route.path}`);
  // The rules are what the composed modules contribute (`contributes.audit`), not a shared constant.
  const rules = mountedAuditRules(subsystems());
  const audited = rules.routes.map(rule => `${rule.method} ${rule.path}`);
  const auditedSockets = rules.sockets.map(rule => `GET ${rule.path}`);
  // The reviewed excuses are one record for both tables; a key names a socket when only the socket table mounts it.
  const excusedSockets = Object.fromEntries(
    Object.entries(NOT_AUDITED).filter(([route]) => sockets.includes(route) && !routes.includes(route)),
  );
  const excused = Object.fromEntries(Object.entries(NOT_AUDITED).filter(([route]) => !(route in excusedSockets)));

  it('should record or explicitly excuse every route that changes something', () => {
    const unreviewed = routes
      .filter(route => !route.startsWith('GET '))
      .filter(route => !audited.includes(route) && excused[route] === undefined);
    should(unreviewed).eql([]);
  });

  it('should record or explicitly excuse every socket', () => {
    should(sockets.filter(route => !auditedSockets.includes(route) && excusedSockets[route] === undefined)).eql([]);
  });

  it('should keep no stale rule and no stale excuse', () => {
    // A rule for a route that is not mounted records nothing, and an excuse for one that is audited, or
    // is gone, is a review that no longer describes the code.
    should(audited.filter(route => !routes.includes(route))).eql([]);
    should(auditedSockets.filter(route => !sockets.includes(route))).eql([]);
    should(Object.keys(excused).filter(route => !routes.includes(route) || audited.includes(route))).eql([]);
    should(Object.keys(excusedSockets).filter(route => !sockets.includes(route) || auditedSockets.includes(route))).eql(
      [],
    );
  });

  it('should give every excuse a reason', () => {
    should(Object.values(NOT_AUDITED).filter(reason => reason.length < 20)).eql([]);
  });
});
