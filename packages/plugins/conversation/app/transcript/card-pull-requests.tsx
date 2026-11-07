import { createContext, type ReactNode, useContext } from 'react';
import type { CardPullRequests } from './board-nudge.ts';

const CardPullRequestsContext = createContext<readonly CardPullRequests[] | undefined>(undefined);

/** The cards this session's board slice holds, with their pull requests, for a line that names one. */
export function CardPullRequestsProvider({
  cards,
  children,
}: {
  readonly cards: readonly CardPullRequests[] | undefined;
  readonly children: ReactNode;
}) {
  return <CardPullRequestsContext.Provider value={cards}>{children}</CardPullRequestsContext.Provider>;
}

export const useCardPullRequests = (): readonly CardPullRequests[] | undefined => useContext(CardPullRequestsContext);
