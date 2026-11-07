import { type CallStanding, decodeParameter, type RecordedCall } from '@ferretry/kernel/contract';
import { type AuditDetail, type AuditDraft, auditKind, type AuthenticatedCredential } from '../../../contract/index.ts';
import { agentAuditDetail, auditActorOf, auditOutcomeOf, routeAuditDraft } from './policy.ts';
import { AUDITED_ROUTES, type AuditedRouteRule } from './routes.ts';

/**
 * THE RECORD ONE AUDITED CALL LEAVES (`Admission.recorded`, today's audited-route decorator `lib/audit/routes.ts`):
 * told by the kernel once per call after the handler of a descriptor that says `audit: { record }`, with the final
 * status and the answer as built. A route today's table names is recorded by its rule; any other recorded route by
 * the descriptor's kind, its one path parameter as the subject and its carrier (`routeAuditDraft`).
 *
 * Pure: the caller writes the draft. `undefined` is "not an act" (a rule's `recordOnlyWhen` said the answer changed
 * nothing), never "could not tell" — an unreadable answer is recorded.
 */
export function recordedCallDraft(
  call: RecordedCall,
  options: {
    readonly rules?: readonly AuditedRouteRule[];
    /** The kind of a config file named by its path under `config/` (the plugin that declares it), if known. */
    readonly configKind?: (path: string) => string | undefined;
  } = {},
): AuditDraft | undefined {
  const declared = call.descriptor.audit;
  if (!('record' in declared)) return undefined;
  const standing = (call.standing ?? {}) as CallStanding;
  const method = 'method' in call.descriptor ? call.descriptor.method : call.request.method;
  const rule = (options.rules ?? AUDITED_ROUTES).find(
    candidate => candidate.method === method && candidate.path === call.descriptor.path,
  );
  // A socket's status is the upgrade's (101 when accepted); today's socket rule recorded the attach as its mode.
  const status = call.table === 'socket' && call.status === 101 ? 200 : call.status;
  if (rule === undefined) {
    const draft = routeAuditDraft(declared.record, { ...call, credential: standing.credential }, status);
    return call.table === 'socket' ? { ...draft, detail: { ...draft.detail, mode: 'attach' } } : draft;
  }
  const body = call.response?.body;
  if (changedNothing(rule, status, body)) return undefined;
  const subject =
    rule.subject === undefined ? rule.fixedSubject : (decodeParameter(call.params.get(rule.subject) ?? '') ?? '');
  return ruleDraft(rule, standing.credential, {
    status,
    body,
    subject,
    code: refusalCodeIn(status, body),
    configKind: options.configKind,
  });
}

interface Answer {
  readonly status: number;
  readonly body: string | undefined;
  readonly subject: string | undefined;
  readonly code: string | undefined;
  readonly configKind: ((path: string) => string | undefined) | undefined;
}

/** Today's `record`, with what the rule may read: the answer's names, settings, fields and refusal code. */
function ruleDraft(
  rule: AuditedRouteRule,
  credential: AuthenticatedCredential | undefined,
  answer: Answer,
): AuditDraft {
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
  const configKind =
    outcome === 'succeeded' && rule.responseConfigKind !== undefined
      ? configKindIn(answer.body, rule.responseConfigKind, answer.configKind)
      : undefined;
  const detail: AuditDetail = {
    ...rule.detail,
    ...agentAuditDetail(credential),
    ...settings,
    ...fields,
    ...(configKind === undefined ? {} : { kind: configKind }),
    ...(names === undefined ? {} : { [(rule.responseNames ?? 'names').split('.').at(-1) as string]: names }),
    ...(rule.refusalCode === true && outcome !== 'succeeded' && answer.code !== undefined ? { code: answer.code } : {}),
    status: answer.status,
  };
  return {
    event: auditKind(outcome === 'succeeded' ? rule.event : (rule.refusedEvent ?? rule.event)),
    actor: auditActorOf(credential),
    ...(answer.subject === undefined || answer.subject === '' ? {} : { subject: answer.subject }),
    outcome,
    ...(Object.keys(detail).length === 0 ? {} : { detail }),
  };
}

/** A 2xx answer that names an outcome other than the one `recordOnlyWhen` wants: not an act. An unreadable answer is recorded. */
function changedNothing(rule: AuditedRouteRule, status: number, body: string | undefined): boolean {
  if (rule.recordOnlyWhen === undefined || auditOutcomeOf(status) !== 'succeeded') return false;
  try {
    const parsed: unknown = JSON.parse(body ?? '');
    const found =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)[rule.recordOnlyWhen.field]
        : undefined;
    return found !== undefined && found !== rule.recordOnlyWhen.equals;
  } catch {
    return false;
  }
}

/** The `code` a refusal was answered with (today read it off the `ApiError`; the kernel hands Gate the answer). */
function refusalCodeIn(status: number, body: string | undefined): string | undefined {
  if (status < 400) return undefined;
  try {
    const parsed: unknown = JSON.parse(body ?? '');
    const code = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).code : undefined;
    return typeof code === 'string' && IDENTIFIER.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** One string-array field of a JSON body, joined — or nothing when the body does not have one. */
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

/** The number and boolean fields of one object inside a JSON body — never text. */
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
    const detail: Record<string, string | number | boolean> = {};
    for (const [key, path] of Object.entries(fields)) {
      const found = valuesAt(parsed, path);
      if (found.length === 1 && typeof found[0] === 'boolean') {
        detail[key] = found[0];
        continue;
      }
      const texts = found.filter((entry): entry is string => typeof entry === 'string' && IDENTIFIER.test(entry));
      const numbers = found.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry));
      if (numbers.length === 1 && found.length === 1) detail[key] = numbers[0] as number;
      else if (numbers.length > 1 && numbers.length === found.length)
        detail[key] = joinedWithin(numbers.map(String), AUDIT_TEXT_MAX);
      else if (texts.length > 0 && texts.length === found.length) detail[key] = joinedWithin(texts, AUDIT_TEXT_MAX);
    }
    return Object.keys(detail).length === 0 ? undefined : detail;
  } catch {
    return undefined;
  }
}

/** The KIND of the configuration file whose path is the response's `field`, never the path or a name in it. */
function configKindIn(
  body: string | undefined,
  field: string,
  kindOf: ((path: string) => string | undefined) | undefined,
): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body ?? '');
    const path = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)[field] : undefined;
    const kind = typeof path === 'string' ? kindOf?.(path) : undefined;
    return kind !== undefined && IDENTIFIER.test(kind) ? kind : undefined;
  } catch {
    return undefined;
  }
}

/** The longest text one audit field holds — `AuditRecordSchema`'s own bound. */
const AUDIT_TEXT_MAX = 160;

/** Names joined with commas, within one field's bound; a list too long ends `+N` for the rest. */
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
