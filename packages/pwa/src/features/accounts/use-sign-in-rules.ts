/** Reads the standing rules of a machine through a secrets-gated client, and says plainly when this device may not. */

import type { SignInRuleList } from '@ferretry/protocol';
import { useCallback, useEffect, useState } from 'react';
import { failureWords, isForbidden, listRules, type RuleClient } from '../../lib/sign-in-rules.ts';

export type RulesRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'failed'; readonly words: string }
  | { readonly kind: 'ready'; readonly list: SignInRuleList };

/** What a rule screen is handed: the client the secrets-gated routes go through, and the passkey ask. */
export interface RulesBinding {
  readonly client: RuleClient;
  /** `undefined` when this device cannot ask for a passkey. */
  readonly askPasskey: ((stage: `srs_${string}`, words: string) => Promise<boolean>) | undefined;
}

/** The list, read once and again on `reload`. A 403 is stated once and not asked again. */
export function useSignInRules(client: RuleClient): { readonly read: RulesRead; readonly reload: () => void } {
  const [read, setRead] = useState<RulesRead>({ kind: 'loading' });
  const [reads, setReads] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` re-runs the read after a change
  useEffect(() => {
    let current = true;
    void listRules(client).then(
      list => {
        if (current) setRead({ kind: 'ready', list });
      },
      cause => {
        if (current)
          setRead(isForbidden(cause) ? { kind: 'forbidden' } : { kind: 'failed', words: failureWords(cause) });
      },
    );
    return () => {
      current = false;
    };
  }, [client, reads]);
  const reload = useCallback(() => setReads(count => count + 1), []);
  return { read, reload };
}
