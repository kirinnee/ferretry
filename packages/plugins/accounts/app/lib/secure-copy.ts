/**
 * The browser's half of secure copy (docs/secure-copy.md): the owner's pre-approval rules. Nothing here is a value:
 * a rule is a route (a program or an origin each way), counts and
 * times. Nothing is cached at module scope, because rules belong to a machine. Every call goes out through the plugin
 * client by route key; every answer is parsed by its schema.
 */

import { z } from 'zod';
import {
  type CopyRouteFrom,
  CopyRouteFromSchema,
  type CopyRouteTo,
  CopyRouteToSchema,
  type PasteRule,
  type PasteRuleCreate,
  PasteRuleCreateSchema,
  type PasteRuleList,
  PasteRuleListSchema,
  type PasteRuleSettings,
  PasteRuleSettingsSchema,
  type PasteRuleSettingsView,
  PasteRuleSettingsViewSchema,
  type PasteRuleStaged,
  PasteRuleStagedSchema,
  PasteRuleSchema,
  PasteRuleStageDroppedSchema,
  type PasteRuleStageId,
  PasteRuleStageListSchema,
  RUNS_WHAT_IT_READS_WARNING,
} from '../../contract/routes/index.ts';
import type { AccountsClient, PasskeyWords } from '../shell.tsx';

export type CopyClient = AccountsClient;

type Init = Parameters<CopyClient['call']>[1];

/** One route by its manifest key, the answer parsed by its schema. */
async function ask<Schema extends z.ZodType>(
  client: CopyClient,
  route: string,
  schema: Schema,
  init?: Init,
): Promise<z.infer<Schema>> {
  return schema.parse(await client.call(route, init));
}

const RemovedSchema = z.strictObject({ removed: z.literal(true) });

export async function listRules(client: CopyClient): Promise<PasteRuleList> {
  return await ask(client, 'GET /v1/copy-rules', PasteRuleListSchema);
}

/** What `GET /v1/copy-rules/settings` came to: the view, or why it could not be read. */
export type CopySettingsRead =
  | { readonly kind: 'view'; readonly view: PasteRuleSettingsView }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * The owner's secure-copy settings and the rules a program from their profile could satisfy. A route of its own; a
 * failure is said, so a hiccup never silently hides the setting and every badge.
 */
export async function readCopySettings(client: CopyClient): Promise<CopySettingsRead> {
  try {
    return { kind: 'view', view: await ask(client, 'GET /v1/copy-rules/settings', PasteRuleSettingsViewSchema) };
  } catch (cause) {
    return { kind: 'failed', reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * Turns programs in the owner's own profile OFF (the one-step write: it only narrows). Turning them ON is a staged
 * change with its own passkey (`stageProfileTargets`).
 */
export async function changeCopySettings(client: CopyClient, settings: PasteRuleSettings): Promise<PasteRuleSettings> {
  return await ask(client, 'PUT /v1/copy-rules/settings', PasteRuleSettingsSchema, {
    body: PasteRuleSettingsSchema.parse(settings),
  });
}

/** STAGE a paste rule: nothing is allowed yet. Answers the daemon's own line and rows, which the passkey prompt lists. */
export async function stagePasteRule(client: CopyClient, rule: PasteRuleCreate): Promise<PasteRuleStaged> {
  return await ask(client, 'POST /v1/copy-rules/stages', PasteRuleStagedSchema, {
    body: PasteRuleCreateSchema.parse(rule),
  });
}

/** The paste rules waiting for a passkey, such as one `fy copy rules add` staged at the machine. */
export async function listPasteRuleStages(client: CopyClient): Promise<readonly PasteRuleStaged[]> {
  return (await ask(client, 'GET /v1/copy-rules/stages', PasteRuleStageListSchema)).stages;
}

/**
 * STAGE turning on programs in your own profile (secrev-1334 M2): nothing changes yet. Answers the daemon's line and a
 * Widens row for every paste rule it would widen, which the passkey prompt lists.
 */
export async function stageProfileTargets(client: CopyClient): Promise<PasteRuleStaged> {
  return await ask(client, 'POST /v1/copy-rules/settings/stages', PasteRuleStagedSchema);
}

/** TAKE a stage the machine made, so this device alone gets its passkey challenge and may commit it. Approves nothing. */
async function bindPasteRuleStage(client: CopyClient, stage: PasteRuleStageId): Promise<PasteRuleStaged> {
  return await ask(client, 'POST /v1/copy-rules/stages/:stage/bind', PasteRuleStagedSchema, { params: { stage } });
}

/** COMMIT a staged change, only after the passkey bound to it: a paste rule, or programs in your own profile turned on. */
async function commitStage(client: CopyClient, staged: PasteRuleStaged): Promise<void> {
  if (staged.kind === 'rule')
    await ask(client, 'POST /v1/copy-rules/stages/:stage/commit', PasteRuleSchema, { params: { stage: staged.stage } });
  else
    await ask(client, 'POST /v1/copy-rules/settings/stages/:stage/commit', PasteRuleSettingsSchema, {
      params: { stage: staged.stage },
    });
}

/** Drops a staged change: the prompt was dismissed, or the owner denied it. Nothing is allowed. */
export async function dropPasteRuleStage(client: CopyClient, stage: PasteRuleStageId): Promise<void> {
  await ask(client, 'DELETE /v1/copy-rules/stages/:stage', PasteRuleStageDroppedSchema, { params: { stage } });
}

/** What the passkey prompt shows for a staged change: the daemon's line and rows, and the red line its flag gives. */
const pasteRulePasskeyWords = (staged: PasteRuleStaged): PasskeyWords => ({
  does: staged.does,
  rows: staged.rows.map(row => ({ label: row.label, value: row.value })),
  warnings: staged.runsAnything ? [RUNS_WHAT_IT_READS_WARNING] : [],
});

/** The passkey act each kind of stage is bound to. */
const STAGE_ACTS = { rule: 'approve-paste-rule', 'profile-targets': 'allow-profile-targets' } as const;
type PasteRuleStageAct = (typeof STAGE_ACTS)[keyof typeof STAGE_ACTS];

/** Asks for the passkey for `act` bound to a stage, showing the daemon's words; `false` when dismissed. */
export type PasteRuleAsk = (stage: PasteRuleStageId, words: PasskeyWords, act: PasteRuleStageAct) => Promise<boolean>;

/** Said when this device cannot run a passkey ceremony at all: the stage is dropped and nothing is approved. */
export const PASTE_RULE_NO_PASSKEY_WORDS =
  'This device cannot confirm with a passkey, so it cannot approve this change. Nothing was approved.';

export type PasteRuleOutcome =
  | { readonly kind: 'made' }
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'failed'; readonly words: string };

const causeWords = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * THE OWNER'S APPROVAL OF ONE STAGED CHANGE (owner decision !A244, secrev-1334): a stage the machine made is TAKEN by
 * this device first (`taken`), then the passkey bound to it is asked with the daemon's own rows, then it is committed.
 * A dismissed or failed prompt DROPS a stage this device made, so nothing waits half-approved; a machine's stage it took
 * keeps waiting (Deny drops it), so the command waiting on it is not told "Denied" by a stray tap.
 */
export async function confirmPasteRuleStage(
  client: CopyClient,
  askPasskey: PasteRuleAsk | undefined,
  staged: PasteRuleStaged,
  options: { readonly taken?: boolean } = {},
): Promise<PasteRuleOutcome> {
  const drop = async (): Promise<void> => {
    if (options.taken !== true) await dropPasteRuleStage(client, staged.stage).catch(() => undefined);
  };
  if (askPasskey === undefined) {
    await drop();
    return { kind: 'failed', words: PASTE_RULE_NO_PASSKEY_WORDS };
  }
  let given: boolean;
  try {
    const held = options.taken === true ? await bindPasteRuleStage(client, staged.stage) : staged;
    given = await askPasskey(held.stage, pasteRulePasskeyWords(held), STAGE_ACTS[held.kind]);
  } catch (cause) {
    await drop();
    return { kind: 'failed', words: causeWords(cause) };
  }
  if (!given) {
    await drop();
    return { kind: 'dismissed' };
  }
  try {
    await commitStage(client, staged);
    return { kind: 'made' };
  } catch (cause) {
    return { kind: 'failed', words: causeWords(cause) };
  }
}

/** REVOKE a paste rule: one tap, no passkey (it only takes away). */
export async function removeRule(client: CopyClient, ruleId: string): Promise<void> {
  await ask(client, 'DELETE /v1/copy-rules/:ruleId', RemovedSchema, { params: { ruleId } });
}

/** Where a value comes from and goes, in plain words: the contract's, which the daemon's rows use too. */
export { pasteFromWords as fromWords, pasteToWords as toWords } from '../../contract/routes/index.ts';

/** What a rule still allows, and for how long, in one line. */
export function ruleLimits(rule: PasteRule): string {
  const count = rule.remaining === undefined ? 'any number of pastes' : `${String(rule.remaining)} more`;
  const scope = rule.sessionId === undefined ? 'any ferret' : 'one ferret';
  const until = rule.expiresAt === undefined ? 'no end' : `until ${rule.expiresAt.slice(0, 16).replace('T', ' ')} UTC`;
  return `${count} · ${scope} · ${until} · used ${String(rule.used)}`;
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
