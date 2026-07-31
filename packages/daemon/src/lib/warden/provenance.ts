/**
 * Provenance for a warden launch: which account and model actually ran the
 * check, and why the daemon picked it.
 *
 * Provenance is daemon-owned, but it round-trips through a JSON sidecar next to
 * the report, so it is parsed back with a schema rather than trusted — a partial
 * or corrupt write must never change a report or the verdict response derived
 * from it.
 */

import { z } from 'zod';

/** How the daemon chooses between candidate accounts. */
export const WardenFailoverPolicySchema = z.enum(['fallback', 'round_robin']);
export type WardenFailoverPolicy = z.infer<typeof WardenFailoverPolicySchema>;

/** Why the account that ran the check was the one selected. */
export const WardenSelectionReasonSchema = z.enum(['preferred', 'failover', 'rotation']);
export type WardenSelectionReason = z.infer<typeof WardenSelectionReasonSchema>;

/** Where the reported model name came from. */
export const WardenModelSourceSchema = z.enum(['harness', 'agent', 'configured', 'unknown']);
export type WardenModelSource = z.infer<typeof WardenModelSourceSchema>;

export const WardenHarnessSchema = z.enum(['claude', 'codex']);
export type WardenHarness = z.infer<typeof WardenHarnessSchema>;

/** Selection facts captured before a warden launch. `skipped` maps each account
 *  the daemon passed over to the reason it passed over it. */
export const WardenSelectionProvenanceSchema = z.object({
  policy: WardenFailoverPolicySchema,
  selection: WardenSelectionReasonSchema,
  configuredFirst: z.string().min(1),
  skipped: z.record(z.string(), z.string()),
});
export type WardenSelectionProvenance = z.infer<typeof WardenSelectionProvenanceSchema>;

/** Daemon-owned facts for one successfully created warden session. */
export const WardenSpawnProvenanceSchema = WardenSelectionProvenanceSchema.extend({
  v: z.literal(1),
  /** Exact session creation instant reported by the start call. */
  at: z.string().min(1),
  wardenSessionId: z.string().min(1),
  /** Assigned-warden target. A fleet sweep has no single target. */
  target: z.string().min(1).optional(),
  /** The account that actually ran, not the one that was requested. */
  agent: z.string().min(1),
  model: z.string().min(1),
  modelSource: WardenModelSourceSchema,
  harness: WardenHarnessSchema,
  failedOver: z.boolean(),
}).refine(value => value.failedOver === derivedFailedOver(value), {
  message: 'failedOver disagrees with the recorded selection evidence',
  path: ['failedOver'],
});
export type WardenSpawnProvenance = z.infer<typeof WardenSpawnProvenanceSchema>;

/** A launch counts as a failover only under the fallback policy, when the
 *  selection actually says failover, and the account that ran differs from the
 *  configured first choice. Derived in one place so the writer and the reader
 *  can never disagree about it. */
function derivedFailedOver(value: {
  readonly policy: WardenFailoverPolicy;
  readonly selection: WardenSelectionReason;
  readonly agent: string;
  readonly configuredFirst: string;
}): boolean {
  return value.policy === 'fallback' && value.selection === 'failover' && value.agent !== value.configuredFirst;
}

/** The launched session as provenance sees it, plus the already-resolved
 *  display model. Model resolution is the runtime's job, not the warden's. */
export interface WardenSpawnFacts {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly agent: string;
  readonly harness: WardenHarness;
  readonly model: string;
  readonly modelSource: WardenModelSource;
}

/** Build provenance from the facts the start call actually returned plus the
 *  daemon's already-computed selection evidence. */
export function buildWardenSpawnProvenance(
  facts: WardenSpawnFacts,
  selection: WardenSelectionProvenance,
  target?: string,
): WardenSpawnProvenance {
  return {
    v: 1,
    at: facts.createdAt,
    wardenSessionId: facts.sessionId,
    ...(target === undefined ? {} : { target }),
    agent: facts.agent,
    model: facts.model,
    modelSource: facts.modelSource,
    harness: facts.harness,
    policy: selection.policy,
    selection: selection.selection,
    configuredFirst: selection.configuredFirst,
    skipped: { ...selection.skipped },
    failedOver: derivedFailedOver({
      policy: selection.policy,
      selection: selection.selection,
      agent: facts.agent,
      configuredFirst: selection.configuredFirst,
    }),
  };
}

/** Sidecar path for a report. */
export function provenancePath(reportPath: string): string {
  return `${reportPath}.meta.json`;
}

/** Parse a sidecar payload, returning `undefined` rather than throwing when it
 *  is partial, corrupt, or internally inconsistent. */
export function parseWardenSpawnProvenance(value: unknown): WardenSpawnProvenance | undefined {
  const parsed = WardenSpawnProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const MODEL_SOURCE_LABEL: Readonly<Record<WardenModelSource, string>> = {
  harness: 'Harness observation',
  agent: 'Account mapping',
  configured: 'Configured model',
  unknown: 'Unknown',
};

const singleLine = (value: string): string => value.replaceAll(/\s+/g, ' ').trim();
const codeValue = (value: string): string => `\`${singleLine(value).replaceAll('`', "'")}\``;
const textValue = (value: string): string => singleLine(value).replaceAll('*', '\\*');

/** Short, scan-friendly markdown, injected into a report only when a valid
 *  sidecar exists. */
export function renderProvenanceMarkdown(meta: WardenSpawnProvenance): string {
  const lines = [
    '## Who ran this check',
    `- Account: **${codeValue(meta.agent)}**`,
    `- Model: **${meta.modelSource === 'unknown' ? 'Unknown' : codeValue(meta.model)}**`,
    `- Model source: **${MODEL_SOURCE_LABEL[meta.modelSource]}**`,
    `- Harness: **${codeValue(meta.harness)}**`,
    `- Warden: **${codeValue(meta.wardenSessionId)}**`,
    `- Failover: **${meta.failedOver ? 'Yes' : 'No'}**`,
  ];
  if (meta.failedOver) {
    lines.push(`- From: **${codeValue(meta.configuredFirst)}**`);
    lines.push(`- Why: **${textValue(meta.skipped[meta.configuredFirst] ?? 'daemon reason unavailable')}**`);
  }
  return lines.join('\n');
}
