/**
 * The state behind a sign-in act's apply panel: whether an act is in flight and the last refusal, beside what this browser
 * may change here (`authority`, read ONCE by the tab through Gate's grants with `useChangeAuthority` and shared by every
 * server's section). The passkey itself is asked for by the carrier when the daemon wants it; nothing here holds or sees a
 * credential.
 */
import type { ChangeAuthority } from '@ferretry/app/ui';
import { useState } from 'react';

export interface SignInChanges {
  /** `null` while it is being read. */
  readonly authority: ChangeAuthority | null;
  /** The last refusal, as one sentence, or `null`. */
  readonly refusal: string | null;
  readonly clear: () => void;
  /** Show a sentence the caller worded where an act's refusal shows. */
  readonly refuse: (sentence: string) => void;
}

export function useSignInChanges(authority: ChangeAuthority | null): SignInChanges {
  const [refusal, setRefusal] = useState<string | null>(null);
  return { authority, refusal, clear: () => setRefusal(null), refuse: setRefusal };
}
