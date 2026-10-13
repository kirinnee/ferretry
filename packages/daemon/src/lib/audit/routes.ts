import type { AuditDetail, AuditEvent } from '@ferretry/protocol';
import { decodeParameter } from '../api/http.ts';
import type { ApiRoute, RouteContext } from '../api/route.ts';
import { auditActorOf, auditOutcomeOf } from './policy.ts';
import type { AuditSink } from './types.ts';

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
  /** The path parameter that names what the request acted on. */
  readonly subject?: string;
  /** When the subject is a device id: resolve its name BEFORE the handler runs, while it still exists. */
  readonly subjectIsDevice?: true;
  /** Fixed facts about this rule, such as which fleet action it was. */
  readonly detail?: AuditDetail;
  /** A top-level string-array field of a successful JSON response holding NAMES, joined into `detail`. */
  readonly responseNames?: string;
}

export const AUDITED_ROUTES: readonly AuditedRouteRule[] = [
  { method: 'POST', path: '/v1/pair/code', event: 'pairing.code-minted' },
  {
    method: 'DELETE',
    path: '/v1/pair/devices/:deviceId',
    event: 'device.revoked',
    subject: 'deviceId',
    subjectIsDevice: true,
  },
  { method: 'PATCH', path: '/v1/grants', event: 'grants.changed' },
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
    path: '/v1/fleet/machine/tools/install',
    event: 'fleet.configured',
    detail: { action: 'install-tool' },
  },
  { method: 'POST', path: '/v1/sessions/:sessionId/terminals', event: 'terminal.opened', subject: 'sessionId' },
  { method: 'POST', path: '/v1/secrets/use', event: 'secrets.used', responseNames: 'used' },
];

/** What the decorator needs: where to write, and how to name a device id. */
export interface AuditedRoutesSubsystem {
  readonly log: AuditSink;
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
      const subject = rule.subject === undefined ? undefined : decodeParameter(context.params.get(rule.subject) ?? '');
      const subjectName =
        rule.subjectIsDevice === true && subject !== undefined ? await subsystem.deviceName(subject) : undefined;
      let status: number | undefined;
      let body: string | undefined;
      try {
        const response = await route.handle(context);
        status = response.status;
        body = response.body;
        return response;
      } catch (error) {
        status = statusOf(error);
        throw error;
      } finally {
        await record(subsystem, context, rule, { status, body, subject, subjectName });
      }
    },
  };
}

interface Answer {
  readonly status: number | undefined;
  readonly body: string | undefined;
  readonly subject: string | undefined;
  readonly subjectName: string | undefined;
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
  const detail: AuditDetail = {
    ...rule.detail,
    ...(answer.subjectName === undefined ? {} : { deviceName: answer.subjectName }),
    ...(names === undefined ? {} : { [rule.responseNames ?? 'names']: names }),
    ...(answer.status === undefined ? {} : { status: answer.status }),
  };
  await subsystem.log.record({
    event: rule.event,
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
    const value = (JSON.parse(body ?? '') as Record<string, unknown>)[field];
    if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) return undefined;
    return value.length === 0 ? undefined : joinedWithin(value, AUDIT_TEXT_MAX);
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
