/**
 * The fake reference surface the HypermediaProse suites prove references with: a fleet of one ferret (`zelda`), the task
 * `&F12`, agenda item `^A3`, a skill `/deploy`, a live terminal `%terminal:live` and a closed one `%terminal:gone`, and one
 * file, `src/api.ts`. Every opener records what it was asked to open. Nothing here reads a network or a real home.
 */
import { type ReferenceSurface, ScreenHrefProvider } from '@ferretry/app';
import type { ReactNode } from 'react';
import { testHref } from '../../../support/app/client.tsx';

interface Opened {
  readonly tasks: string[];
  readonly agendas: string[];
  readonly files: string[];
  readonly surfaces: string[];
  readonly skills: string[];
  readonly navigated: string[];
}

export interface Fixture {
  readonly surface: ReferenceSurface;
  readonly opened: Opened;
  /** Flip a kind to "no longer provable" WITHOUT re-rendering anything: the next proof says no. */
  readonly gone: { task: boolean; surface: boolean };
}

export const fixture = (): Fixture => {
  const opened: Opened = { tasks: [], agendas: [], files: [], surfaces: [], skills: [], navigated: [] };
  const gone = { task: false, surface: false };
  const surface: ReferenceSurface = {
    agentReferenceResolver: ({ name, sessionId }) =>
      name === 'zelda' || sessionId === 's-zelda' ? { daemonId: 'd1', sessionId: 's-zelda', name: 'zelda' } : null,
    taskReferenceResolver: id => !gone.task && id === 'F12',
    agendaReferenceResolver: id => id === 'A3',
    skillReferenceResolver: name => name === 'deploy',
    surfaceReferenceResolver: ({ key }) =>
      key === 'live' && !gone.surface
        ? { state: 'open', daemonId: 'd1', sessionId: 's-zelda', surface: 'terminal', key }
        : key === 'gone' || gone.surface
          ? { state: 'closed' }
          : null,
    resolveFilePaths: async candidates =>
      new Map(candidates.filter(path => path === 'src/api.ts').map(path => [path, path])),
    onCodeReferenceOpen: reference => void opened.files.push(reference.path),
    onTaskOpen: id => void opened.tasks.push(id),
    onAgendaOpen: id => void opened.agendas.push(id),
    onSurfaceOpen: target => void opened.surfaces.push(`${target.surface}:${target.key}`),
    onSkillOpen: name => void opened.skills.push(name),
    onNavigate: to => void opened.navigated.push(to),
  };
  return { surface, opened, gone };
};

/** A row is drawn where screen addresses resolve, as the shell draws it. */
export const inShell = (node: ReactNode): ReactNode => <ScreenHrefProvider href={testHref}>{node}</ScreenHrefProvider>;
