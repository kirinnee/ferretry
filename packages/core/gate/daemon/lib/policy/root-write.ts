import type { RootWriteJudgement } from '@ferretry/kernel/contract';

/** The manifest permits asking; this decision is solely the current caller's configure grant. */
export function judgeRootWrite(input: RootWriteJudgement): boolean {
  const governance = input.standing?.governance;
  if (governance === undefined) return false;
  if (governance.governed === false) return true;
  try {
    // Admission already handled this act's confirmation. Recheck grants/unlock without spending a second proof.
    return governance.decide({ capability: input.capability, axis: 'configure', narrowing: true }).allowed === true;
  } catch {
    return false;
  }
}
