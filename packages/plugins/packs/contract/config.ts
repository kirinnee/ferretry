import { defineConfig, defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { PackCleanUpJobResultSchema } from './cleanup.ts';
import { type PacksFile, PacksFileSchema, packConfigFromFile, RoutingUndoSchema } from './wire.ts';

/**
 * Which edits of `packs.yaml` LOOSEN what Pack mode may do or spend (§7.2): a loosening edit is held for the owner. Each
 * entry is a plain sentence naming what widened. Switching things off, lowering a limit or a cap never loosens; neither
 * does the routing prompt (it only says which model suits which work) or the probe.
 */
export function packsLoosens(before: PacksFile | undefined, after: PacksFile): readonly string[] {
  const was = packConfigFromFile(before ?? {});
  const now = packConfigFromFile(after);
  const out: string[] = [];
  if (!was.enabled && now.enabled) out.push('Pack mode is switched on');
  if (was.decision !== 'jev' && now.decision === 'jev') out.push('Jev decides which model a helper runs on');
  for (const limit of ['interactiveChildren', 'autoChildren', 'maxDepth'] as const)
    if (now.limits[limit] > was.limits[limit]) out.push(`the ${limit} limit is raised`);
  if (now.jev.usdPerDay > was.jev.usdPerDay) out.push("Jev's daily cap is raised");
  return out;
}

/** `config/packs.yaml`: the switch, the decision mode, the limits, the probe, Jev's cap and the routing prompt. */
export const PACKS_CONFIG = defineConfig({
  file: 'packs.yaml',
  schema: PacksFileSchema,
  axis: 'configure',
  loosens: packsLoosens,
});

/** `run.json` in a Clean up run's folder: the job and, once read, its checked suggestion. */
export const PackRunFileSchema = PackCleanUpJobResultSchema.extend({ format: z.literal(1) });
export type PackRunFile = z.infer<typeof PackRunFileSchema>;
/**
 * `state/packs/runs/<id>/`: one Clean up run's folder — `run.json` (above), the rough prompt (`rough.txt`), the idea
 * (`idea.txt`), the inventory it was shown (`inventory.json`) and the draft the short-lived ferret writes (`draft.json`).
 * The ferret writes the draft itself, so the folder is opaque to the store; the daemon reads `run.json` with the schema.
 */
export const PACK_RUNS = defineState({ name: 'runs', path: 'runs/*', store: 'opaque', format: 1 });

/** `state/packs/replaced.json`: the routing prompt the last accepted clean-up replaced, so ONE undo puts it back. */
export const ReplacedRoutingSchema = RoutingUndoSchema.extend({ format: z.literal(1), text: z.string().nullable() });
export type ReplacedRouting = z.infer<typeof ReplacedRoutingSchema>;
export const PACK_REPLACED = defineState({
  name: 'replaced',
  path: 'replaced.json',
  store: 'json',
  format: 1,
  schema: ReplacedRoutingSchema,
});

/**
 * `state/packs/jev-spend.json`: Jev's Pack-mode spend, per UTC day. A day that is not today reads as nothing spent; an
 * unreadable document reads as the cap already reached (damaged is not empty), so a broken ledger can never let Jev spend
 * without bound.
 */
export const JevSpendSchema = z.strictObject({ format: z.literal(1), day: z.string().min(1), usd: z.number().min(0) });
export type JevSpend = z.infer<typeof JevSpendSchema>;
export const PACK_JEV_SPEND = defineState({
  name: 'jev-spend',
  path: 'jev-spend.json',
  store: 'json',
  format: 1,
  schema: JevSpendSchema,
});

/** `state/packs/switches.json`: the ferrets whose own Pack switch is off or on (absent means on). */
export const SwitchesSchema = z.strictObject({
  format: z.literal(1),
  ferrets: z.record(z.string(), z.strictObject({ enabled: z.boolean(), at: z.string().min(1) })),
});
export type Switches = z.infer<typeof SwitchesSchema>;
export const PACK_SWITCHES = defineState({
  name: 'switches',
  path: 'switches.json',
  store: 'json',
  format: 1,
  schema: SwitchesSchema,
});
