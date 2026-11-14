/**
 * "OPEN THIS FILE IN FILES": how another panel of the same ferret page (the Instructions list) asks the Files panel to open
 * a file, without either holding the other. The Files panel subscribes for ONE ferret on ONE daemon (`scopeKey`) and opens
 * what is asked, once per request; a request with no Files panel mounted is simply not heard, so nothing opens on a later
 * mount by surprise.
 */
import { useRef, useSyncExternalStore } from 'react';
import type { CodeReferenceOpenRequest } from './files-tab-model.ts';
import { type FilesScope, scopeKey } from './scope.ts';

const latest = new Map<string, CodeReferenceOpenRequest>();
const listeners = new Map<string, Set<() => void>>();
let sequence = 0;

/** Asks the Files panel of this ferret to open `path` (relative to the ferret's folder). */
export const requestFileOpen = (scope: FilesScope, path: string): void => {
  const key = scopeKey(scope);
  sequence += 1;
  latest.set(key, { sequence, reference: { path } });
  for (const listener of listeners.get(key) ?? []) listener();
};

/** The newest request for this ferret, or null: handed to `FilesTab` as `requestedReference`. */
export const useFileOpenRequest = (scope: FilesScope | null): CodeReferenceOpenRequest | null => {
  const key = scope === null ? null : scopeKey(scope);
  // What was asked before this panel mounted is not its to open.
  const before = useRef<{ readonly key: string | null; readonly sequence: number } | null>(null);
  if (before.current === null || before.current.key !== key)
    before.current = { key, sequence: key === null ? 0 : (latest.get(key)?.sequence ?? 0) };
  const request = useSyncExternalStore(
    notify => {
      if (key === null) return () => undefined;
      const set = listeners.get(key) ?? new Set<() => void>();
      listeners.set(key, set);
      set.add(notify);
      return () => {
        set.delete(notify);
      };
    },
    () => (key === null ? null : (latest.get(key) ?? null)),
    () => null,
  );
  return request !== null && request.sequence > before.current.sequence ? request : null;
};
