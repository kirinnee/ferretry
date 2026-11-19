import { createContext, type ReactNode, useContext } from 'react';
import type { PullAddress, PullsClient } from './api.ts';
import type { DiffRange } from './quote.ts';

/** What every composer under one PR page needs, and the three ways text reaches the page's comment draft. */
export interface ComposeValue {
  readonly client: PullsClient;
  readonly address: PullAddress;
  /** The PR's own address on GitHub: where the preview's "open on GitHub" links go. */
  readonly pullUrl: string;
  /** The head commit a diff-line comment is made against. */
  readonly headSha: string;
  /** The GitHub login a post goes out as; `undefined` while it is being read, `null` when there is none to read. */
  readonly login: string | null | undefined;
  /** The PR page reads itself again (a post changed it, or may have). */
  readonly changed: () => void;
  /** Adds a quote to the comment draft, opening it when it is closed. */
  readonly quote: (selected: string, range?: DiffRange) => void;
  /** Opens a comment on diff lines. `false` when another draft with text in it is open. */
  readonly commentOnLines: (range: DiffRange) => boolean;
  /** Opens a blank comment on the PR. */
  readonly openComment: () => void;
}

const ComposeContext = createContext<ComposeValue | undefined>(undefined);

export function useCompose(): ComposeValue {
  const value = useContext(ComposeContext);
  if (value === undefined) throw new Error('a composer was drawn outside the PR page');
  return value;
}

/** For a part that works with or without a PR page around it (a quote scope in a test): `undefined` when there is none. */
export const useMaybeCompose = (): ComposeValue | undefined => useContext(ComposeContext);

export function ComposeFrame({ value, children }: { readonly value: ComposeValue; readonly children: ReactNode }) {
  return <ComposeContext.Provider value={value}>{children}</ComposeContext.Provider>;
}
