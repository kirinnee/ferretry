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
  type PasteRuleSettings,
  PasteRuleSettingsSchema,
  type PasteRuleSettingsView,
  PasteRuleSettingsViewSchema,
  type PasteRuleStaged,
  PasteRuleStagedSchema,
  PasteRuleStageDroppedSchema,
  type PasteRuleStageId,
  PasteRuleStageListSchema,
  RUNS_WHAT_IT_READS_WARNING,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { z } from 'zod';
import { targetRef } from './input-card.ts';
import type { StepUpWords } from './step-up-gate.ts';

export type CopyClient = Pick<IFyApiClient, 'request'>;

const RULES_PATH = '/v1/copy-rules';
const STAGES_PATH = `${RULES_PATH}/stages`;
const stagePath = (stage: PasteRuleStageId): string => `${STAGES_PATH}/${encodeURIComponent(stage)}`;
const RemovedSchema = z.strictObject({ removed: z.literal(true) });

export async function listRules(client: CopyClient): Promise<PasteRuleList> {
  return await client.request(RULES_PATH, PasteRuleListSchema);
}

/** The one-step create, for a daemon that does not stage paste rules (`copy-rules.passkey.1` not reported). */
export async function addRule(client: CopyClient, rule: PasteRuleCreate): Promise<PasteRule> {
  return await client.request(RULES_PATH, PasteRuleSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(PasteRuleCreateSchema.parse(rule)),
  });
}

/** What `GET /v1/copy-rules/settings` came to: the view, a daemon too old to have it, or why it could not be read. */
export type CopySettingsRead =
  | { readonly kind: 'view'; readonly view: PasteRuleSettingsView }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * The owner's secure-copy settings and the rules a program from their profile could satisfy. A route of its own: only a
 * 404 means a daemon too old to have it (no setting, no badge, nothing to warn about); any other failure is said, so a
 * hiccup never silently hides the setting and every badge.
 */
export async function readCopySettings(client: CopyClient): Promise<CopySettingsRead> {
  try {
    return { kind: 'view', view: await client.request(`${RULES_PATH}/settings`, PasteRuleSettingsViewSchema) };
  } catch (cause) {
    if (cause instanceof FyHttpError && cause.status === 404) return { kind: 'unsupported' };
    return { kind: 'failed', reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * Changes the owner's secure-copy settings. Turning profile targets ON from a paired device needs a passkey for that
 * act: the daemon answers with the step-up demand and the client's gate asks for it, then sends this again.
 */
export async function changeCopySettings(client: CopyClient, settings: PasteRuleSettings): Promise<PasteRuleSettings> {
  return await client.request(`${RULES_PATH}/settings`, PasteRuleSettingsSchema, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(PasteRuleSettingsSchema.parse(settings)),
  });
}

/** STAGE a paste rule: nothing is allowed yet. Answers the daemon's own line and rows, which the passkey prompt lists. */
export async function stagePasteRule(client: CopyClient, rule: PasteRuleCreate): Promise<PasteRuleStaged> {
  return await client.request(STAGES_PATH, PasteRuleStagedSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(PasteRuleCreateSchema.parse(rule)),
  });
}

/** The paste rules waiting for a passkey, such as one `fy copy rules add` staged at the machine. */
export async function listPasteRuleStages(client: CopyClient): Promise<readonly PasteRuleStaged[]> {
  return (await client.request(STAGES_PATH, PasteRuleStageListSchema)).stages;
}

/** COMMIT: only after the `approve-paste-rule` passkey bound to this stage. */
async function commitPasteRuleStage(client: CopyClient, stage: PasteRuleStageId): Promise<PasteRule> {
  return await client.request(`${stagePath(stage)}/commit`, PasteRuleSchema, { method: 'POST' });
}

/** Drops a staged paste rule: the prompt was dismissed, or the owner denied it. Nothing is allowed. */
export async function dropPasteRuleStage(client: CopyClient, stage: PasteRuleStageId): Promise<void> {
  await client.request(stagePath(stage), PasteRuleStageDroppedSchema, { method: 'DELETE' });
}

/** What the passkey prompt shows for a staged paste rule: the daemon's line and rows, and the red line its flag gives. */
const pasteRulePasskeyWords = (staged: PasteRuleStaged): StepUpWords => ({
  does: staged.does,
  rows: staged.rows.map(row => ({ label: row.label, value: row.value })),
  warnings: staged.runsAnything ? [RUNS_WHAT_IT_READS_WARNING] : [],
});

/** Asks for the `approve-paste-rule` passkey bound to a stage, showing the daemon's words; `false` when dismissed. */
export type PasteRuleAsk = (stage: PasteRuleStageId, words: StepUpWords) => Promise<boolean>;

/** Said when this device cannot run a passkey ceremony at all: the stage is dropped and nothing is approved. */
export const PASTE_RULE_NO_PASSKEY_WORDS =
  'This device cannot confirm with a passkey, so it cannot approve a paste rule. Nothing was approved.';

export type PasteRuleOutcome =
  | { readonly kind: 'made'; readonly rule: PasteRule }
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'failed'; readonly words: string };

const causeWords = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * THE OWNER'S APPROVAL OF ONE STAGED PASTE RULE (owner decision !A244): ask for the passkey bound to the stage with the
 * daemon's own rows, then commit. A dismissed or failed prompt DROPS the stage, so nothing waits half-approved.
 */
export async function confirmPasteRuleStage(
  client: CopyClient,
  ask: PasteRuleAsk | undefined,
  staged: PasteRuleStaged,
): Promise<PasteRuleOutcome> {
  const drop = async (): Promise<void> => {
    await dropPasteRuleStage(client, staged.stage).catch(() => undefined);
  };
  if (ask === undefined) {
    await drop();
    return { kind: 'failed', words: PASTE_RULE_NO_PASSKEY_WORDS };
  }
  let given: boolean;
  try {
    given = await ask(staged.stage, pasteRulePasskeyWords(staged));
  } catch (cause) {
    await drop();
    return { kind: 'failed', words: causeWords(cause) };
  }
  if (!given) {
    await drop();
    return { kind: 'dismissed' };
  }
  try {
    return { kind: 'made', rule: await commitPasteRuleStage(client, staged.stage) };
  } catch (cause) {
    return { kind: 'failed', words: causeWords(cause) };
  }
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

/** Where a value comes from and goes, in plain words: the protocol's, which the daemon's rows use too. */
export { pasteFromWords as fromWords, pasteToWords as toWords } from '@ferretry/protocol';

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
      ? `${source.from.path ?? source.from.program ?? 'a command'} (what it printed)`
      : `${source.from.origin ?? 'a page'}${source.from.kind === 'clipboard' ? ' (its clipboard)' : ''}`;
  const facts = request.observed;
  const to =
    facts === undefined
      ? targetRef(request)
      : facts.kind === 'terminal'
        ? `${facts.foreground.comm} in %terminal:${request.target.key}`
        : facts.kind === 'secret'
          ? `the secret ${facts.name}${facts.exists ? ' (replacing its value)' : ' (new)'}`
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
