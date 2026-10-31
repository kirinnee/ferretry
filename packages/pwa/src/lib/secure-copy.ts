/**
 * The browser's half of secure copy (docs/secure-copy.md): the owner's pre-approval rules and a ferret's paste
 * plans. Nothing here is a value: a rule and a plan are routes (a program or an origin each way), counts and
 * times. Nothing is cached at module scope, because rules belong to a machine.
 */

import {
  type CopyPlan,
  type CopyPlanList,
  CopyPlanListSchema,
  CopyPlanSchema,
  type CopyRouteFrom,
  CopyRouteFromSchema,
  type CopyRouteTo,
  CopyRouteToSchema,
  type IFyApiClient,
  type InputRequest,
  type PasteRule,
  type PasteRuleCreate,
  PasteRuleCreateSchema,
  type PasteRuleList,
  PasteRuleListSchema,
  PasteRuleSchema,
} from '@ferretry/protocol';
import { z } from 'zod';

export type CopyClient = Pick<IFyApiClient, 'request'>;

const RULES_PATH = '/v1/copy-rules';
const RemovedSchema = z.strictObject({ removed: z.literal(true) });

export async function listRules(client: CopyClient): Promise<PasteRuleList> {
  return await client.request(RULES_PATH, PasteRuleListSchema);
}

export async function addRule(client: CopyClient, rule: PasteRuleCreate): Promise<PasteRule> {
  return await client.request(RULES_PATH, PasteRuleSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(PasteRuleCreateSchema.parse(rule)),
  });
}

export async function removeRule(client: CopyClient, id: string): Promise<void> {
  await client.request(`${RULES_PATH}/${encodeURIComponent(id)}`, RemovedSchema, { method: 'DELETE' });
}

export async function listPlans(client: CopyClient): Promise<CopyPlanList> {
  return await client.request('/v1/copy-plans', CopyPlanListSchema);
}

/** Allows the plan's items by index; none declines it. */
export async function answerPlan(client: CopyClient, plan: CopyPlan, items: readonly number[]): Promise<CopyPlan> {
  return await client.request(
    `/v1/sessions/${encodeURIComponent(plan.sessionId)}/copy-plans/${encodeURIComponent(plan.id)}/approve`,
    CopyPlanSchema,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [...items] }) },
  );
}

/** Where a value comes from, in plain words: "what gh prints", "text on https://github.com". */
export function fromWords(from: CopyRouteFrom): string {
  if (from.kind === 'command') return `what ${from.program} prints`;
  return from.kind === 'browser' ? `text on ${from.origin}` : `the clipboard of ${from.origin}`;
}

/** Where a value goes, in plain words: "vercel in a terminal", "a field on https://vercel.com", "the secret NAME". */
export function toWords(to: CopyRouteTo): string {
  if (to.kind === 'terminal') return `${to.program} in a terminal`;
  return to.kind === 'browser' ? `a field on ${to.origin}` : `the secret ${to.name}`;
}

/** What a rule still allows, and for how long, in one line. */
export function ruleLimits(rule: PasteRule): string {
  const count = rule.remaining === undefined ? 'any number of pastes' : `${String(rule.remaining)} more`;
  const scope = rule.sessionId === undefined ? 'any ferret' : 'one ferret';
  const until = rule.expiresAt === undefined ? 'no end' : `until ${rule.expiresAt.slice(0, 16).replace('T', ' ')} UTC`;
  return `${count} · ${scope} · ${until} · used ${String(rule.used)}`;
}

/** The two ends of a paste card: where its copy came from, and what the daemon saw reading the destination. */
export function pasteRoute(request: InputRequest): { readonly from: string; readonly to: string } | undefined {
  const source = request.source;
  if (source === undefined) return undefined;
  const from =
    source.from.kind === 'command'
      ? `${source.from.program ?? 'a command'} (what it printed)`
      : `${source.from.origin ?? 'a page'}${source.from.kind === 'clipboard' ? ' (its clipboard)' : ''}`;
  const facts = request.observed;
  const to =
    facts === undefined
      ? `%${request.target.kind}:${request.target.key}`
      : facts.kind === 'terminal'
        ? `${facts.foreground.comm} in %terminal:${request.target.key}`
        : `a field on ${facts.origin}`;
  return { from, to };
}

/** The add form's two ends, read from what the owner picked and typed, or the sentence saying what is wrong. */
export function ruleFromForm(form: {
  readonly fromKind: CopyRouteFrom['kind'];
  readonly from: string;
  readonly toKind: CopyRouteTo['kind'];
  readonly to: string;
  readonly count: string;
  readonly hours: string;
}): { readonly ok: true; readonly rule: PasteRuleCreate } | { readonly ok: false; readonly problem: string } {
  const from = CopyRouteFromSchema.safeParse(
    form.fromKind === 'command'
      ? { kind: 'command', program: form.from.trim() }
      : { kind: form.fromKind, origin: form.from.trim() },
  );
  if (!from.success)
    return {
      ok: false,
      problem:
        form.fromKind === 'command'
          ? 'Name the program, like gh.'
          : 'Name the page by its origin, like https://github.com.',
    };
  const to = CopyRouteToSchema.safeParse(
    form.toKind === 'terminal'
      ? { kind: 'terminal', program: form.to.trim() }
      : form.toKind === 'secret'
        ? { kind: 'secret', name: form.to.trim() }
        : { kind: 'browser', origin: form.to.trim() },
  );
  if (!to.success)
    return {
      ok: false,
      problem:
        form.toKind === 'terminal'
          ? 'Name the program reading the terminal, like vercel.'
          : form.toKind === 'secret'
            ? 'Name the secret in capitals, like VERCEL_TOKEN.'
            : 'Name the page by its origin, like https://vercel.com.',
    };
  const count = form.count.trim() === '' ? undefined : Number(form.count);
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 100))
    return { ok: false, problem: 'A count is a whole number from 1 to 100, or empty for no count.' };
  const hours = form.hours.trim() === '' ? undefined : Number(form.hours);
  if (hours !== undefined && (!Number.isFinite(hours) || hours <= 0 || hours > 720))
    return { ok: false, problem: 'Hours are more than 0 and at most 720 (30 days), or empty for no end.' };
  return {
    ok: true,
    rule: {
      from: from.data,
      to: to.data,
      ...(count === undefined ? {} : { count }),
      ...(hours === undefined ? {} : { expiresInSeconds: Math.max(60, Math.round(hours * 3600)) }),
    },
  };
}
