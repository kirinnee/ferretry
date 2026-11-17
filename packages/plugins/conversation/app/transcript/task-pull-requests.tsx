import { createContext, useContext } from 'react';
import type { TaskPullRequests } from './board-nudge.ts';

const TaskPullRequestsContext = createContext<readonly TaskPullRequests[] | undefined>(undefined);

export const useTaskPullRequests = (): readonly TaskPullRequests[] | undefined => useContext(TaskPullRequestsContext);
