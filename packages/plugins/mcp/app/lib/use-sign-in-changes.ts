/**
 * The state behind a sign-in act's apply panel: what this browser may change here (read once through Gate's grants,
 * `useChangeAuthority`), whether an act is in flight, and the last refusal. The passkey itself is asked for by the
 * carrier when the daemon wants it; nothing here holds or sees a credential.
 */
import { type ChangeAuthority, useChangeAuthority } from '@ferretry/app/ui';
import { useState } from 'react';
import type { McpClient } from './client.ts';

export interface SignInChanges {
  /** `null` while it is being read. */
  readonly authority: ChangeAuthority | null;
  /** The last refusal, as one sentence, or `null`. */
  readonly refusal: string | null;
  readonly clear: () => void;
  /** Show a sentence the caller worded where an act's refusal shows. */
  readonly refuse: (sentence: string) => void;
}

export function useSignInChanges(client: McpClient): SignInChanges {
  const authority = useChangeAuthority(client);
  const [refusal, setRefusal] = useState<string | null>(null);
  return { authority, refusal, clear: () => setRefusal(null), refuse: setRefusal };
}
