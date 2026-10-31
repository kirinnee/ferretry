import type { AuditDetail, AuditEvent, AuditOutcome } from '@ferretry/protocol';
import { ApiError } from '../api/error.ts';
import { decodeParameter } from '../api/http.ts';
import type { ApiRoute, RouteContext } from '../api/route.ts';
import type { SocketAttachment, SocketRoute } from '../api/socket.ts';
import { auditActorOf, auditOutcomeOf } from './policy.ts';
import type { AuditFailureReporter, AuditSink } from './types.ts';

/**
 * WHICH ROUTES ARE AUDITED, AND WHY THE TABLE IS DECORATED RATHER THAN EACH HANDLER EDITED.
 *
 * Every site this log covers is a route somebody else owns. Wrapping the finished route table is one
 * line in the mount index instead of a change in seven files, and it audits relayed requests for free:
 * a relayed request is dispatched through this very table, so there is no second path to forget.
 *
 * WHAT A RULE MAY READ IS THE GUARANTEE. A rule names a path parameter to use as the subject and, at
 * most, a list of NAMES out of the response — never the request body, never anything else from the
 * response. That is what makes "no code, token, key or command line" structural here: the pairing
 * redemption (whose response IS a token) is not on this table at all — see `AuditedPairingService` —
 * and the secret-use response is read for its `used` names and nothing else, never its output.
 *
 * WHAT IT CANNOT SEE — DECLARED. A request the authorization boundary refuses before the handler runs
 * (a switched-off grant, a missing credential) never reaches a handler and is not recorded here.
 */
export interface AuditedRouteRule {
  readonly method: string;
  readonly path: string;
  readonly event: AuditEvent;
  /** The event a refused or failed request is recorded as, when it is not `event` — a failed step-up. */
  readonly refusedEvent?: AuditEvent;
  /** The path parameter that names what the request acted on. */
  readonly subject?: string;
  /** A subject that is the same for every request — the name of the setting a `security.changed` changed. */
  readonly fixedSubject?: string;
  /** When the subject is a device id: resolve its name BEFORE the handler runs, while it still exists. */
  readonly subjectIsDevice?: true;
  /** Fixed facts about this rule, such as which fleet action it was. */
  readonly detail?: AuditDetail;
  /**
   * A top-level field of a successful JSON response holding a NAME or an array of names, joined into
   * `detail` under the same key.
   */
  readonly responseNames?: string;
  /**
   * Copy the `code` of the refusal an `ApiError` raised into `detail`, for a rule whose refusals mean different
   * things to a reader — the codes are a fixed vocabulary the daemon chose, never text a person typed.
   */
  readonly refusalCode?: true;
  /**
   * A top-level OBJECT of a successful JSON response whose number and boolean fields are copied into
   * `detail` — the settings a `security.changed` left in place, so a reader sees `idleExpiryDays: 1`.
   * Only scalars that are not text are taken, so nothing typed by a person can come along.
   */
  readonly responseSettings?: readonly string[];
  /**
   * Named facts out of a successful JSON response, copied into `detail` under the key given: a path of field
   * names, with `*` for every element of an array. Only an identifier-shaped string (an id, a digest) or a
   * finite number is taken, so nothing a person typed can come along.
   */
  readonly responseFields?: Readonly<Record<string, readonly string[]>>;
}

export const AUDITED_ROUTES: readonly AuditedRouteRule[] = [
  { method: 'POST', path: '/v1/pair/code', event: 'pairing.code-minted' },
  { method: 'DELETE', path: '/v1/pair/code/:pairingId', event: 'pairing.code-revoked', subject: 'pairingId' },
  {
    method: 'DELETE',
    path: '/v1/pair/devices/:deviceId',
    event: 'device.revoked',
    subject: 'deviceId',
    subjectIsDevice: true,
  },
  { method: 'POST', path: '/v1/push/subscriptions', event: 'push.changed', detail: { action: 'enrol' } },
  {
    method: 'DELETE',
    path: '/v1/push/subscriptions/:pushId',
    event: 'push.changed',
    subject: 'pushId',
    detail: { action: 'remove' },
  },
  { method: 'PATCH', path: '/v1/grants', event: 'grants.changed' },
  {
    method: 'PATCH',
    path: '/v1/pair/devices/:deviceId/grants',
    event: 'grants.changed',
    subject: 'deviceId',
    subjectIsDevice: true,
    detail: { scope: 'device' },
  },
  {
    method: 'PATCH',
    path: '/v1/security',
    event: 'security.changed',
    fixedSubject: 'security-settings',
    responseSettings: ['view', 'settings'],
  },
  // A tunnel changes how other devices reach this machine — a hostname on Cloudflare's edge in front of it
  // — so switching it is kept as a change to the machine's security, beside the settings above.
  { method: 'PUT', path: '/v1/tunnel', event: 'security.changed', fixedSubject: 'tunnel' },
  // Updating this machine runs new code on it, and turning on automatic updates lets it do so unasked:
  // both are kept as changes to the machine's security, like its settings.
  { method: 'POST', path: '/v1/daemon/update', event: 'security.changed', fixedSubject: 'daemon-update' },
  // Updating an agent CLI puts new code on the machine that every new ferret then runs as.
  { method: 'POST', path: '/v1/harnesses/update', event: 'security.changed', fixedSubject: 'harness-update' },
  {
    method: 'PATCH',
    path: '/v1/daemon/update/settings',
    event: 'security.changed',
    fixedSubject: 'daemon-update-settings',
    responseSettings: [],
  },
  // A secure-copy rule lets a ferret paste a value it holds without asking each time (docs/secure-copy.md): adding
  // one, or approving a ferret's plan of them, loosens what agents may do; removing one narrows it. All are kept.
  {
    method: 'POST',
    path: '/v1/copy-rules',
    event: 'security.changed',
    fixedSubject: 'copy-rule',
    detail: { action: 'added' },
  },
  {
    method: 'DELETE',
    path: '/v1/copy-rules/:ruleId',
    event: 'security.changed',
    subject: 'ruleId',
    detail: { action: 'removed' },
  },
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/copy-plans/:planId/approve',
    event: 'security.changed',
    subject: 'planId',
    detail: { action: 'plan-answered' },
  },
  { method: 'POST', path: '/v1/passkeys', event: 'passkey.registered' },
  {
    method: 'POST',
    path: '/v1/passkeys/registration-window',
    event: 'security.changed',
    fixedSubject: 'passkey-registration-window',
  },
  // A confirmation and an unlock are ACTIVITY, not changes: each is a person proving it is them, and a
  // device can repeat them, so they fold. A refused one is a failed guess and folds like every refusal.
  {
    method: 'POST',
    path: '/v1/step-up',
    event: 'step-up.succeeded',
    refusedEvent: 'step-up.failed',
    detail: { action: 'step-up' },
  },
  {
    method: 'POST',
    path: '/v1/unlock',
    event: 'step-up.succeeded',
    refusedEvent: 'step-up.failed',
    detail: { action: 'unlock' },
  },
  { method: 'POST', path: '/v1/fleet/proposals', event: 'fleet.configured', detail: { action: 'propose' } },
  {
    method: 'POST',
    path: '/v1/fleet/proposals/:proposalId/apply',
    event: 'fleet.configured',
    subject: 'proposalId',
    detail: { action: 'apply' },
  },
  { method: 'POST', path: '/v1/fleet/login', event: 'fleet.configured', detail: { action: 'sign-in' } },
  {
    method: 'POST',
    path: '/v1/fleet/login/:flowId',
    event: 'fleet.configured',
    subject: 'flowId',
    detail: { action: 'sign-in-answer' },
  },
  {
    method: 'DELETE',
    path: '/v1/fleet/login/:flowId',
    event: 'fleet.configured',
    subject: 'flowId',
    detail: { action: 'sign-in-cancel' },
  },
  // MCP sign-in (docs/mcp-oauth.md): the component NAME and the flow id, never an address or a token.
  {
    method: 'POST',
    path: '/v1/fleet/mcp-auth/:component',
    event: 'fleet.configured',
    subject: 'component',
    detail: { action: 'mcp-sign-in' },
  },
  {
    method: 'POST',
    path: '/v1/fleet/mcp-auth/flows/:flowId',
    event: 'fleet.configured',
    subject: 'flowId',
    responseNames: 'component',
    detail: { action: 'mcp-sign-in-finish' },
  },
  {
    method: 'DELETE',
    path: '/v1/fleet/mcp-auth/flows/:flowId',
    event: 'fleet.configured',
    subject: 'flowId',
    detail: { action: 'mcp-sign-in-cancel' },
  },
  {
    method: 'DELETE',
    path: '/v1/fleet/mcp-auth/:component',
    event: 'fleet.configured',
    subject: 'component',
    detail: { action: 'mcp-sign-out' },
  },
  {
    method: 'POST',
    path: '/v1/fleet/machine/tools/install',
    event: 'fleet.configured',
    detail: { action: 'install-tool' },
  },
  // Keeping existing conversations as ferrets (`mounts/conversation-import.ts`): it creates sessions that can
  // launch agents, so it is recorded as fleet configuration. The record names no conversation and no folder.
  {
    method: 'POST',
    path: '/v1/imports/conversations/adopt',
    event: 'fleet.configured',
    detail: { action: 'adopt-conversations' },
  },
  // Adding an MCP server for one ferret (`mounts/session-mcp.ts`): the session and the server's NAME, never
  // its command, address or environment. Both change what agents launch with, the project file for
  // everyone on the repository and the login for every ferret on it, so both are recorded as fleet
  // configuration, told apart by `scope`.
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/mcp/project',
    event: 'fleet.configured',
    subject: 'sessionId',
    responseNames: 'name',
    detail: { action: 'mcp-add', scope: 'project' },
  },
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/mcp/login',
    event: 'fleet.configured',
    subject: 'sessionId',
    responseNames: 'name',
    detail: { action: 'mcp-add', scope: 'login' },
  },
  // Installing, or removing, an item from a catalog someone else published (`mounts/catalog-installs.ts`): the
  // item's NAME, never a file, command or secret. `code` says why a refusal was one — a signature that did
  // not verify, a publisher that changed, a file edited here — because those mean different things to a reader.
  {
    method: 'POST',
    path: '/v1/catalog-installs/project',
    event: 'fleet.configured',
    responseNames: 'install.provenance.name',
    refusalCode: true,
    detail: { action: 'catalog-install', scope: 'project' },
  },
  {
    method: 'POST',
    path: '/v1/catalog-installs/runtime',
    event: 'fleet.configured',
    responseNames: 'install.provenance.name',
    refusalCode: true,
    detail: { action: 'catalog-install', scope: 'runtime' },
  },
  {
    method: 'DELETE',
    path: '/v1/catalog-installs/project/:installId',
    event: 'fleet.configured',
    subject: 'installId',
    responseNames: 'provenance.name',
    refusalCode: true,
    detail: { action: 'catalog-remove', scope: 'project' },
  },
  {
    method: 'DELETE',
    path: '/v1/catalog-installs/runtime/:installId',
    event: 'fleet.configured',
    subject: 'installId',
    responseNames: 'provenance.name',
    refusalCode: true,
    detail: { action: 'catalog-remove', scope: 'runtime' },
  },
  { method: 'POST', path: '/v1/sessions/:sessionId/terminals', event: 'terminal.opened', subject: 'sessionId' },
  // Typing into the session's own pane from the Console: counted on the session and folded per window,
  // exactly as a terminal socket's keystrokes are — the request body is never read.
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/console/input',
    event: 'terminal.input',
    subject: 'sessionId',
    detail: { mode: 'console' },
  },
  // Stopping one of the ferret's processes from the Processes tab: an act on its pane, like Ctrl-C into the
  // Console, counted on the session the same way and never naming which one.
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/processes/:processId/stop',
    event: 'terminal.input',
    subject: 'sessionId',
    detail: { mode: 'process-stop' },
  },
  // Answering a permission prompt is keys into the same pane: counted the same way, never with the choice.
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/permission',
    event: 'terminal.input',
    subject: 'sessionId',
    detail: { mode: 'permission' },
  },
  // So is answering a harness dialog.
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/dialog',
    event: 'terminal.input',
    subject: 'sessionId',
    detail: { mode: 'dialog' },
  },
  // Enter on, or an erase of, the person's own draft in the agent's composer — never with the text.
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/composer',
    event: 'terminal.input',
    subject: 'sessionId',
    detail: { mode: 'composer' },
  },
  { method: 'POST', path: '/v1/secrets/use', event: 'secrets.used', responseNames: 'used' },
  // A speed-up Test spends one provider key on the operator's account; the secret's NAME is the subject.
  {
    method: 'POST',
    path: '/v1/speedups/:provider/test',
    event: 'secrets.used',
    responseNames: 'secretName',
    detail: { action: 'speedup-test' },
  },
  // A login Test spends that login's key once on the operator's account; the login is the subject.
  {
    method: 'POST',
    path: '/v1/fleet/credentials/:credentialId/test',
    event: 'secrets.used',
    subject: 'credentialId',
    detail: { action: 'login-test' },
  },
  {
    method: 'POST',
    path: '/v1/secrets',
    event: 'secrets.changed',
    responseNames: 'name',
    detail: { action: 'put' },
  },
  {
    method: 'DELETE',
    path: '/v1/secrets/:name',
    event: 'secrets.changed',
    subject: 'name',
    detail: { action: 'delete' },
  },
  // Saved logins (docs/input-requests.md) are the secret store too: every change is kept, by handle only.
  {
    method: 'PUT',
    path: '/v1/secrets/logins/:id',
    event: 'secrets.changed',
    subject: 'id',
    detail: { action: 'login-put' },
  },
  {
    method: 'POST',
    path: '/v1/secrets/logins/:id/rename',
    event: 'secrets.changed',
    subject: 'id',
    detail: { action: 'login-rename' },
  },
  {
    method: 'DELETE',
    path: '/v1/secrets/logins/:id',
    event: 'secrets.changed',
    subject: 'id',
    detail: { action: 'login-delete' },
  },
  // Copying secrets to another machine: both ends name the SAME import id as the subject, so the source's
  // record and the target's can be matched up by eye. Names only — the bundle is never read here.
  {
    method: 'POST',
    path: '/v1/secrets/exports/:importId',
    event: 'secrets.used',
    subject: 'importId',
    responseNames: 'names',
    detail: { action: 'clone-export' },
  },
  {
    method: 'POST',
    path: '/v1/secrets/imports/:importId',
    event: 'secrets.changed',
    subject: 'importId',
    responseNames: 'imported',
    detail: { action: 'clone-import' },
  },
  // Catalogs this machine publishes (docs/catalogs.md): ids, names and digests only — never what an item holds.
  // The brief the person read is the item; the log keeps WHICH item and WHICH version left, and where it went.
  {
    method: 'POST',
    path: '/v1/catalogs',
    event: 'catalog.changed',
    detail: { action: 'create' },
    responseFields: { catalogId: ['id'], revision: ['revision'] },
  },
  {
    method: 'PATCH',
    path: '/v1/catalogs/:id',
    event: 'catalog.changed',
    subject: 'id',
    detail: { action: 'update' },
    responseFields: { revision: ['revision'] },
  },
  { method: 'DELETE', path: '/v1/catalogs/:id', event: 'catalog.changed', subject: 'id', detail: { action: 'delete' } },
  {
    method: 'POST',
    path: '/v1/catalogs/:id/items',
    event: 'catalog.changed',
    subject: 'id',
    detail: { action: 'publish' },
    responseFields: { itemId: ['itemId'], itemVersion: ['itemVersion'], digest: ['digest'], revision: ['revision'] },
  },
  {
    method: 'POST',
    path: '/v1/catalogs/:id/items/:itemId/versions',
    event: 'catalog.changed',
    subject: 'id',
    detail: { action: 'publish' },
    responseFields: { itemId: ['itemId'], itemVersion: ['itemVersion'], digest: ['digest'], revision: ['revision'] },
  },
  {
    method: 'DELETE',
    path: '/v1/catalogs/:id/items/:itemId',
    event: 'catalog.changed',
    subject: 'id',
    detail: { action: 'withdraw' },
    responseFields: { itemId: ['itemId'], revision: ['revision'] },
  },
  {
    method: 'POST',
    path: '/v1/catalogs/:id/export',
    event: 'catalog.exported',
    subject: 'id',
    responseFields: { revision: ['signedManifest', 'manifest', 'revision'], itemIds: ['items', '*', 'itemId'] },
  },
  { method: 'POST', path: '/v1/worktrees/remove', event: 'worktree.removed' },
  { method: 'POST', path: '/v1/browser/login', event: 'browser.opened', detail: { action: 'sign-in-window' } },
  // A proxy test makes this machine dial a proxy with the stored credentials, so it is kept by name: only whether
  // it reached, how long it took and the error class — never an address, a header or a credential. A refused
  // caller (an agent) reaches the handler and is recorded as refused.
  {
    method: 'POST',
    path: '/v1/browser/proxy/test',
    event: 'browser.proxy-tested',
    fixedSubject: 'browser-proxy',
    responseSettings: [],
    responseNames: 'errorClass',
  },
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/browser',
    event: 'browser.opened',
    subject: 'sessionId',
    detail: { action: 'control' },
  },
  { method: 'POST', path: '/v1/sessions', event: 'session.opened', detail: { action: 'start' } },
  // A sub-ferret start goes through the same start (docs/pack-mode.md); its own action keeps it apart from
  // a plain start, so the two never fold into one record.
  { method: 'POST', path: '/v1/pack/new', event: 'session.opened', detail: { action: 'sub-ferret' } },
  // Clean up is a short-lived ferret a person started (docs/pack-mode.md § Clean up).
  {
    method: 'POST',
    path: '/v1/pack/routing/clean-up',
    event: 'session.opened',
    detail: { action: 'routing-clean-up' },
  },
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/fork',
    event: 'session.opened',
    subject: 'sessionId',
    detail: { action: 'fork' },
  },
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/send',
    event: 'agent.prompted',
    subject: 'sessionId',
    detail: { action: 'send' },
  },
  // A refused migration's "ask the agent to stop its background jobs" puts Ferretry's words in the agent's
  // queue: it prompts the agent as a send does, so it is recorded the same way.
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/migrate/ask-to-stop-jobs',
    event: 'agent.prompted',
    subject: 'sessionId',
    detail: { action: 'ask-to-stop-jobs' },
  },
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/sends/:sendId/retry',
    event: 'agent.prompted',
    subject: 'sessionId',
    detail: { action: 'send-retry' },
  },
  // Taking a send back can erase it from the agent's composer, and Enter submits it: both change what
  // the agent is told, so both are recorded as prompting it — never with the text.
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/sends/:sendId/cancel',
    event: 'agent.prompted',
    subject: 'sessionId',
    detail: { action: 'send-cancel' },
  },
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/sends/:sendId/enter',
    event: 'agent.prompted',
    subject: 'sessionId',
    detail: { action: 'send-enter' },
  },
  // Rewording or taking back a queued message changes what the agent will be told, so both are recorded
  // as prompting it — never with the text — exactly as a send's own cancel is.
  {
    method: 'PATCH',
    path: '/v1/sessions/:sessionId/queue/:messageId',
    event: 'agent.prompted',
    subject: 'sessionId',
    detail: { action: 'queue-edit' },
  },
  {
    method: 'DELETE',
    path: '/v1/sessions/:sessionId/queue/:messageId',
    event: 'agent.prompted',
    subject: 'sessionId',
    detail: { action: 'queue-cancel' },
  },
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/answer',
    event: 'agent.prompted',
    subject: 'sessionId',
    detail: { action: 'answer' },
  },
  { method: 'POST', path: '/v1/warden/run', event: 'warden.ran' },
  // An owner's request spends an investigation, so it is recorded as a run of its own kind.
  { method: 'POST', path: '/v1/warden/investigate', event: 'warden.ran', detail: { action: 'investigate' } },
  // Leaving a ferret alone switches its supervision off for a while: a change to how the Warden behaves.
  { method: 'POST', path: '/v1/warden/leave', event: 'warden.configured', detail: { action: 'leave' } },
  { method: 'PATCH', path: '/v1/warden/config', event: 'warden.configured' },
  // The configuration files (docs/config-files.md). Nothing from the body — no path, no text — is
  // recorded: which file changed is the file's own business, and its text may be what was wrong.
  { method: 'PUT', path: '/v1/config/file', event: 'fleet.configured', detail: { action: 'config-write' } },
  // Each rewrites models-guide.yaml, as an edit through the configuration routes would.
  { method: 'POST', path: '/v1/pack/routing/accept', event: 'fleet.configured', detail: { action: 'routing-accept' } },
  { method: 'POST', path: '/v1/pack/routing/undo', event: 'fleet.configured', detail: { action: 'routing-undo' } },
  { method: 'POST', path: '/v1/config/confirm', event: 'fleet.configured', detail: { action: 'config-confirm' } },
  { method: 'POST', path: '/v1/agent/config', event: 'fleet.configured', detail: { action: 'agent-config' } },
  // Lessons (docs/learning.md): the machine default written into `learning.yaml`, and an Apply — the one
  // write outside the state home, into the global instructions or a project's AGENTS.md / CLAUDE.md.
  { method: 'PATCH', path: '/v1/learning/config', event: 'fleet.configured', detail: { action: 'learning-config' } },
  {
    method: 'POST',
    path: '/v1/learning/proposals/:id/apply',
    event: 'fleet.configured',
    subject: 'id',
    detail: { action: 'lesson-apply' },
  },
];

/** What the decorator needs: where to write, and how to name a device id. */
export interface AuditedRoutesSubsystem {
  readonly log: AuditSink;
  /** Where a record that could not be made is said out loud, since it may not fail the request. */
  readonly failures: AuditFailureReporter;
  deviceName(deviceId: string): Promise<string | undefined>;
}

/** The route table, with every route a rule names recorded after it answers. */
export function auditedRoutes(
  subsystem: AuditedRoutesSubsystem,
  routes: readonly ApiRoute[],
  rules: readonly AuditedRouteRule[] = AUDITED_ROUTES,
): readonly ApiRoute[] {
  return routes.map(route => {
    const rule = rules.find(candidate => candidate.method === route.method && candidate.path === route.path);
    return rule === undefined ? route : audited(subsystem, route, rule);
  });
}

function audited(subsystem: AuditedRoutesSubsystem, route: ApiRoute, rule: AuditedRouteRule): ApiRoute {
  return {
    ...route,
    handle: async context => {
      const subject =
        rule.subject === undefined ? rule.fixedSubject : decodeParameter(context.params.get(rule.subject) ?? '');
      const subjectName =
        rule.subjectIsDevice === true && subject !== undefined
          ? await subsystem.deviceName(subject).catch(() => undefined)
          : undefined;
      let status: number | undefined;
      let body: string | undefined;
      let code: string | undefined;
      try {
        const response = await route.handle(context);
        status = response.status;
        body = response.body;
        return response;
      } catch (error) {
        status = statusOf(error);
        code = error instanceof ApiError ? error.code : undefined;
        throw error;
      } finally {
        // A record that throws would turn a request that already WORKED into a 500 from here, and the
        // person would retry something that happened. `AuditLog` already reports its own failures; this
        // catches what is left — a device-name lookup, a sink that is not an `AuditLog`.
        await record(subsystem, context, rule, { status, body, subject, subjectName, code }).catch((error: unknown) =>
          subsystem.failures.auditWriteFailed(describeFailure(rule, error)),
        );
      }
    },
  };
}

interface Answer {
  readonly status: number | undefined;
  readonly body: string | undefined;
  readonly subject: string | undefined;
  readonly subjectName: string | undefined;
  readonly code: string | undefined;
}

async function record(
  subsystem: AuditedRoutesSubsystem,
  context: RouteContext,
  rule: AuditedRouteRule,
  answer: Answer,
): Promise<void> {
  const credential = context.credential;
  const actorName = credential?.tokenClass === 'device' ? await subsystem.deviceName(credential.deviceId) : undefined;
  const outcome = auditOutcomeOf(answer.status);
  const names =
    outcome === 'succeeded' && rule.responseNames !== undefined ? namesIn(answer.body, rule.responseNames) : undefined;
  const settings =
    outcome === 'succeeded' && rule.responseSettings !== undefined
      ? settingsIn(answer.body, rule.responseSettings)
      : undefined;
  const fields =
    outcome === 'succeeded' && rule.responseFields !== undefined
      ? fieldsIn(answer.body, rule.responseFields)
      : undefined;
  const detail: AuditDetail = {
    ...rule.detail,
    ...settings,
    ...fields,
    ...(answer.subjectName === undefined ? {} : { deviceName: answer.subjectName }),
    ...(names === undefined ? {} : { [(rule.responseNames ?? 'names').split('.').at(-1) as string]: names }),
    ...(rule.refusalCode === true && outcome !== 'succeeded' && answer.code !== undefined ? { code: answer.code } : {}),
    ...(answer.status === undefined ? {} : { status: answer.status }),
  };
  await subsystem.log.record({
    event: outcome === 'succeeded' ? rule.event : (rule.refusedEvent ?? rule.event),
    actor: auditActorOf(credential, actorName),
    ...(answer.subject === undefined || answer.subject === '' ? {} : { subject: answer.subject }),
    outcome,
    ...(Object.keys(detail).length === 0 ? {} : { detail }),
  });
}

/** The status an error would be answered with: an `ApiError` says, anything else is a failure. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

/**
 * One string-array field of a JSON body, joined — or nothing when the body does not have one.
 *
 * Only an array of strings is taken, so a field that turned out to hold anything richer is dropped
 * rather than flattened into the log.
 */
function namesIn(body: string | undefined, field: string): string | undefined {
  try {
    let parsed: unknown = JSON.parse(body ?? '');
    for (const key of field.split('.')) parsed = (parsed as Record<string, unknown> | null)?.[key];
    const value = typeof parsed === 'string' ? [parsed] : parsed;
    if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) return undefined;
    return value.length === 0 ? undefined : joinedWithin(value, AUDIT_TEXT_MAX);
  } catch {
    return undefined;
  }
}

/**
 * The number and boolean fields of one object inside a JSON body — or nothing when there is none.
 *
 * Text is never taken, and the keys must already read as detail keys, so the result always fits the
 * record's contract and cannot carry anything a person typed.
 */
function settingsIn(body: string | undefined, path: readonly string[]): AuditDetail | undefined {
  try {
    let value: unknown = JSON.parse(body ?? '');
    for (const key of path) value = (value as Record<string, unknown> | null)?.[key];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    return Object.fromEntries(
      Object.entries(value).filter(
        ([key, field]) =>
          /^[a-z][A-Za-z0-9]{0,31}$/u.test(key) &&
          (typeof field === 'boolean' || (typeof field === 'number' && Number.isFinite(field))),
      ),
    ) as AuditDetail;
  } catch {
    return undefined;
  }
}

/** What `responseFields` may copy: an id, a digest, a revision — never free text. */
const IDENTIFIER = /^[A-Za-z0-9_:.-]{1,160}$/u;

function valuesAt(value: unknown, path: readonly string[]): readonly unknown[] {
  const [head, ...rest] = path;
  if (head === undefined) return [value];
  if (head === '*') return Array.isArray(value) ? value.flatMap(entry => valuesAt(entry, rest)) : [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return valuesAt((value as Record<string, unknown>)[head], rest);
}

/** The facts a rule names out of a JSON body: one value, or several joined, under the key it chose. */
function fieldsIn(
  body: string | undefined,
  fields: Readonly<Record<string, readonly string[]>>,
): AuditDetail | undefined {
  try {
    const parsed: unknown = JSON.parse(body ?? '');
    const detail: Record<string, string | number> = {};
    for (const [key, path] of Object.entries(fields)) {
      const found = valuesAt(parsed, path);
      const texts = found.filter((entry): entry is string => typeof entry === 'string' && IDENTIFIER.test(entry));
      const numbers = found.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry));
      if (numbers.length === 1 && found.length === 1) detail[key] = numbers[0] as number;
      else if (texts.length > 0 && texts.length === found.length) detail[key] = joinedWithin(texts, AUDIT_TEXT_MAX);
    }
    return Object.keys(detail).length === 0 ? undefined : detail;
  } catch {
    return undefined;
  }
}

/** The longest text one audit field holds — `AuditRecordSchema`'s own bound. */
const AUDIT_TEXT_MAX = 160;

/**
 * Names joined with commas, within one field's bound.
 *
 * A list too long to fit keeps the names that do and ends `+N` for the rest, so the record still says
 * how many there were rather than failing the contract and leaving a gap instead.
 */
function joinedWithin(names: readonly string[], limit: number): string {
  const all = names.join(',');
  if (all.length <= limit) return all;
  const kept: string[] = [];
  for (const name of names) {
    const rest = names.length - kept.length - 1;
    if ([...kept, name, `+${String(rest)}`].join(',').length > limit) break;
    kept.push(name);
  }
  return [...kept, `+${String(names.length - kept.length)}`].join(',');
}

function describeFailure(rule: { readonly event: AuditEvent }, error: unknown): string {
  return `the security log could not record a ${rule.event} event, so it has a gap: ${error instanceof Error ? error.message : String(error)}`;
}

/** One protocol-switching route the log records: opening it, and — for a terminal — typing into it. */
export interface AuditedSocketRule {
  readonly path: string;
  readonly event: AuditEvent;
  /** The path parameter that names what was attached to. */
  readonly subject: string;
  /** Recorded for every BINARY client frame — keystrokes — and folded per subject per window. */
  readonly inputEvent?: AuditEvent;
}

/**
 * The sockets that hand a caller something live. The fleet feed is a read, so it is not here — the
 * contract in `tests/unit/runtime/mounts/surface.test.ts` holds it to the reviewed list in
 * `tests/unit/audit/not-audited.ts`.
 */
export const AUDITED_SOCKET_ROUTES: readonly AuditedSocketRule[] = [
  {
    path: '/v1/sessions/:sessionId/terminals/:terminalId/stream',
    event: 'terminal.opened',
    subject: 'terminalId',
    inputEvent: 'terminal.input',
  },
  { path: '/v1/sessions/:sessionId/browser/stream', event: 'browser.opened', subject: 'sessionId' },
];

/**
 * The socket table, with every attach a rule names recorded as `detail.mode: 'attach'`.
 *
 * WHY ATTACH IS ITS OWN RECORD. Opening a terminal is one act; reaching an EXISTING shell somebody
 * else opened is another, and it is the one a stolen phone would do. A refused upgrade is recorded as
 * refused, exactly like an HTTP route.
 *
 * INPUT IS COUNTED, NEVER CAPTURED. Each binary frame is one `terminal.input` record naming the
 * terminal and nothing about the bytes; `AuditLog` folds them per terminal per window, so a session of
 * typing is a handful of lines that say how many frames arrived. Attaches fold the same way, per
 * device and terminal, so re-attaching in a loop is one counted line a minute and never reaches the
 * kept store. The record is not awaited: a keystroke must never wait on a disk.
 */
export function auditedSocketRoutes(
  subsystem: AuditedRoutesSubsystem,
  routes: readonly SocketRoute[],
  rules: readonly AuditedSocketRule[] = AUDITED_SOCKET_ROUTES,
): readonly SocketRoute[] {
  return routes.map(route => {
    const rule = rules.find(candidate => route.method === 'GET' && candidate.path === route.path);
    return rule === undefined ? route : auditedSocket(subsystem, route, rule);
  });
}

function auditedSocket(subsystem: AuditedRoutesSubsystem, route: SocketRoute, rule: AuditedSocketRule): SocketRoute {
  return {
    ...route,
    accept: async context => {
      const subject = decodeParameter(context.params.get(rule.subject) ?? '');
      const entry = async (event: AuditEvent, outcome: AuditOutcome, detail?: AuditDetail): Promise<void> => {
        const credential = context.credential;
        const actorName =
          credential?.tokenClass === 'device' ? await subsystem.deviceName(credential.deviceId) : undefined;
        await subsystem.log.record({
          event,
          actor: auditActorOf(credential, actorName),
          ...(subject === '' ? {} : { subject }),
          outcome,
          ...(detail === undefined ? {} : { detail }),
        });
      };
      const said = (event: AuditEvent, outcome: AuditOutcome, detail?: AuditDetail): Promise<void> =>
        entry(event, outcome, detail).catch((error: unknown) =>
          subsystem.failures.auditWriteFailed(describeFailure({ event }, error)),
        );
      let attach: SocketAttachment;
      try {
        attach = await route.accept(context);
      } catch (error) {
        await said(rule.event, auditOutcomeOf(statusOf(error)), { mode: 'attach' });
        throw error;
      }
      await said(rule.event, 'succeeded', { mode: 'attach' });
      const inputEvent = rule.inputEvent;
      if (inputEvent === undefined) return attach;
      return async downstream => {
        const handler = await attach(downstream);
        return {
          open: async () => await handler.open(),
          close: () => handler.close(),
          fromClient: frame => {
            if (typeof frame !== 'string') void said(inputEvent, 'succeeded');
            handler.fromClient(frame);
          },
        };
      };
    },
  };
}
