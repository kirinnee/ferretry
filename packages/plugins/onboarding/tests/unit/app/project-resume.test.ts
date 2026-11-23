/** Project setup left unfinished is read from the device's own ledger and later list (no second store). */
import { describe, expect, it } from 'bun:test';
import { instantFromEpochMs } from '@ferretry/std';
import { rememberLater } from '../../../app/features/setup-flow/client-later.ts';
import { markProjectSetupShown, unfinishedProjectSetup } from '../../../app/features/setup-flow/project-resume.ts';
import { recordClientStep, type LedgerStorage } from '../../../app/lib/index.ts';

const memory = (): LedgerStorage => {
  const map = new Map<string, string>();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) };
};
const at = instantFromEpochMs(1_700_000_000_000);
const A = `fy_daemon_${'a'.repeat(43)}`;

describe('unfinishedProjectSetup', () => {
  it('is nothing for a device that was never shown project setup', () => {
    expect(unfinishedProjectSetup(memory())).toBeUndefined();
    expect(unfinishedProjectSetup(undefined)).toBeUndefined();
  });

  it('names the machine once project setup was shown and not answered', () => {
    const storage = memory();
    expect(markProjectSetupShown(storage, A, at)).toBe(true);
    expect(unfinishedProjectSetup(storage)).toBe(A);
  });

  it('is nothing once Next answered it (the ledger) or Skip for now left it (the later list)', () => {
    const answered = memory();
    markProjectSetupShown(answered, A, at);
    recordClientStep(answered, 'projects', 'folders', A, at);
    expect(unfinishedProjectSetup(answered)).toBeUndefined();

    const skipped = memory();
    markProjectSetupShown(skipped, A, at);
    rememberLater(skipped, 'projects.folders', at);
    expect(unfinishedProjectSetup(skipped)).toBeUndefined();
  });
});
