import { createContext, useContext } from 'react';
import type { CardPullRequests } from './board-nudge.ts';

const CardPullRequestsContext = createContext<readonly CardPullRequests[] | undefined>(undefined);

export const useCardPullRequests = (): readonly CardPullRequests[] | undefined => useContext(CardPullRequestsContext);
