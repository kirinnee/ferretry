/**
 * Task fixtures for the feature-surface suites.
 *
 * The record shape is the protocol's, not a local re-declaration, so a schema
 * change breaks these fixtures at compile time rather than letting a screen
 * render a shape the daemon no longer sends.
 */

import type { TaskLive, TaskSummary } from '@ferretry/protocol';

const taskLive = (overrides: Partial<TaskLive> = {}): TaskLive => ({
  assigneeSessionId: null,
  assigneeName: null,
  assigneeStatus: null,
  assigneeHealth: null,
  assigneeDoneMarker: false,
  assigneeLastActivityAt: null,
  staleness: null,
  ...overrides,
});

/** `live` is deliberately a partial of its own: a suite almost always cares
 *  about one annotation and should not have to restate the other six. */
export type TaskSummaryOverrides = Partial<Omit<TaskSummary, 'live'>> & { readonly live?: Partial<TaskLive> };

export const taskSummary = (overrides: TaskSummaryOverrides = {}): TaskSummary => ({
  v: 1,
  id: 'F12',
  kind: 'feature',
  title: 'Fix the transcript scroller',
  workflow: 'quick',
  phase: 'todo',
  dependsOn: [],
  status: 'todo',
  statusReason: null,
  assignee: null,
  repo: null,
  files: [],
  links: { prs: [], branch: null, commits: [], docs: [] },
  order: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  createdBy: null,
  updatedAt: '2026-07-02T00:00:00.000Z',
  descriptionChars: 0,
  askChars: 0,
  askSource: 'human',
  clarificationCount: 0,
  blocked: false,
  blockedReason: null,
  blockedSince: null,
  blockedBy: [],
  ...overrides,
  live: taskLive(overrides.live),
});
