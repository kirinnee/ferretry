/**
 * The registered folders, hydrated once and read as a slice. This is the input to the ferret list's grouping: with a
 * real list the registered-path branch decides which of two NESTED folders a worktree belongs to, and the scope
 * machine's missing-folder recovery can tell "that folder is gone" from "that folder currently has no ferrets".
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { ProjectInfo } from '../../contract/index.ts';
import type { ProjectsSlice, ProjectsStore } from '../lib/projects-store.ts';

/** Hydrates the registry and returns its slice. */
export const useProjectsSlice = (store: ProjectsStore): ProjectsSlice => {
  useEffect(() => {
    // A failed registry read is a slice status, not something a mount rethrows.
    void store.hydrate().catch(() => {});
  }, [store]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
};

/** The rows grouping consumes. Identity-stable while unread, so it cannot re-group on every render. */
export const useProjects = (store: ProjectsStore): readonly ProjectInfo[] => {
  useProjectsSlice(store);
  return store.projects();
};

/** Reads what is already known without hydrating anything. */
export const useKnownProjects = (store: ProjectsStore): readonly ProjectInfo[] => {
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return store.projects();
};
