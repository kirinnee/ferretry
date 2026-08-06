import { describe, expect, it } from 'bun:test';
import type { ProjectInfo } from '@ferretry/protocol';

import {
  activeProjectSessions,
  projectBoardSessions,
  projectSessions,
} from '../../../src/features/projects/project-detail-model.ts';
import { projectLaunchRequest } from '../../../src/features/projects/project-launch-model.ts';
import { sessionView } from '../../support/sessions.ts';

const project: ProjectInfo = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'registry',
  path: '/work/registry/',
  source: 'existing-folder',
  createdAt: '2026-08-01T00:00:00.000Z',
};

describe('project detail model', () => {
  it('derives the exact normalized-cwd session set, newest activity first', () => {
    const sessions = projectSessions(project, [
      sessionView('older', {
        config: { cwd: '/work/registry' },
        state: { lastActivityAt: '2026-08-01T00:00:00.000Z' },
      }),
      sessionView('newer', {
        config: { cwd: '/work/registry/' },
        state: { lastActivityAt: '2026-08-03T00:00:00.000Z' },
      }),
      sessionView('nested', { config: { cwd: '/work/registry/packages/pwa' } }),
    ]);

    expect(sessions.map(session => session.config.id)).toEqual(['newer', 'older']);
  });

  it('keeps active and board projections honest and separately derived from that session set', () => {
    const sessions = projectSessions(project, [
      sessionView('active', { config: { cwd: '/work/registry', boardAccess: 'worker' } }),
      sessionView('finished', {
        config: { cwd: '/work/registry', boardAccess: 'none' },
        state: { status: 'completed' },
      }),
    ]);

    expect(activeProjectSessions(sessions).map(session => session.config.id)).toEqual(['active']);
    expect(projectBoardSessions(sessions).map(session => session.config.id)).toEqual(['active']);
  });

  it('builds only the existing top-level interactive creation contract', () => {
    expect(projectLaunchRequest(' claude-auto-loge ', project.path)).toEqual({
      agent: 'claude-auto-loge',
      cwd: '/work/registry/',
      mode: 'interactive',
      boardAccess: 'none',
    });
  });
});
