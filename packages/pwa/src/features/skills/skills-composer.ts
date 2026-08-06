/** Deliver one harness-specific skill invocation to one exact composer. */

import { type AddReferenceOutcome, draftCarriesReference } from '../../lib/composer-references.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { composerQuoteTarget } from '../../lib/quote.ts';
import { parseReferenceToken } from '../../lib/references.ts';
import { appendSkillInvocation } from './skills-catalog.ts';

/**
 * Adds `/name` or `$name` without canonicalising away the harness distinction.
 * The shared reference parser proves the invocation; the exact session-scoped
 * composer registry owns delivery.
 */
export const addSkillInvocationToComposer = (invocation: string, scope: DaemonSessionScope): AddReferenceOutcome => {
  const token = invocation.trim();
  const reference = parseReferenceToken(token);
  if (reference?.kind !== 'skill') return 'rejected';
  const target = composerQuoteTarget(scope);
  if (target === null) return 'no-composer';
  const draft = target.draft();
  if (draftCarriesReference(draft, reference)) return 'duplicate';
  target.replaceDraft(appendSkillInvocation(draft, token));
  return 'added';
};
