import {
  type DialogRule,
  DialogRuleSchema,
  type DialogRuleHarness,
  type HarnessDialogRules,
} from '../contract/dialog-rules.ts';

/** One harness's hook, read now: what its plugin provides, `'unavailable'` when it is off or failed, or nothing at all. */
export interface DialogRuleProvision {
  readonly harness: DialogRuleHarness;
  readonly provided: HarnessDialogRules | 'unavailable' | undefined;
}

/** The built-in rules the harness plugins hand the Warden, validated; and the words a ferret is told after one declines. */
export interface BuiltInDialogRules {
  /** Every rule that passed, claude's then codex's. A harness with no provider gives none. */
  rules(): readonly DialogRule[];
  /** What a ferret is told after `ruleId` declined its prompt, or `undefined`: a rule with no entry says nothing. */
  nudgeOf(ruleId: string): string | undefined;
}

/**
 * THE BUILT-IN RULES, from the harness plugins that draw the screens. Each is read LIVE at every look (a plugin that
 * starts late is heard from the next look) and FAILS CLOSED: a rule the schema refuses (a row that grants, a pattern that
 * does not compile), one that names another harness than the hook's, or one whose id another rule already took, is
 * dropped and journalled once. The Warden only ever presses what it could have been taught itself.
 */
export function builtInDialogRules(
  read: () => readonly DialogRuleProvision[],
  record: (type: string, data: Readonly<Record<string, string>>) => void,
): BuiltInDialogRules {
  let nudges: Readonly<Record<string, string>> = {};
  const told = new Set<string>();
  const refuse = (harness: string, rule: string, why: string): void => {
    const key = `${harness}\u0000${rule}\u0000${why}`;
    if (told.has(key)) return;
    told.add(key);
    record('fleet.warden_dialog_rule_refused', { harness, rule, why });
  };
  return {
    rules: () => {
      const kept: DialogRule[] = [];
      const taken = new Set<string>();
      const words: Record<string, string> = {};
      for (const { harness, provided } of read()) {
        if (provided === undefined || provided === 'unavailable') continue;
        const accepted = new Set<string>();
        for (const candidate of provided.rules) {
          const id = typeof (candidate as { id?: unknown }).id === 'string' ? candidate.id : '?';
          const parsed = DialogRuleSchema.safeParse(candidate);
          if (!parsed.success) {
            refuse(harness, id, parsed.error.issues[0]?.message ?? 'not a rule');
            continue;
          }
          if (parsed.data.harness !== harness) {
            refuse(harness, id, `it is for ${parsed.data.harness}, not ${harness}`);
            continue;
          }
          if (taken.has(parsed.data.id)) {
            refuse(harness, id, 'another rule has that id');
            continue;
          }
          taken.add(parsed.data.id);
          accepted.add(parsed.data.id);
          kept.push(parsed.data);
        }
        for (const [id, text] of Object.entries(provided.nudges ?? {}))
          if (accepted.has(id) && text.length > 0) words[id] = text;
      }
      nudges = words;
      return kept;
    },
    nudgeOf: ruleId => nudges[ruleId],
  };
}
