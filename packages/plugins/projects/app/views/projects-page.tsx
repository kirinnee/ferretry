/**
 * ONE DAEMON'S REGISTRY, BOUND TO THE STORE THAT OWNS ITS FACTS.
 *
 * This half is deliberately thin: it reads the registry slice and the ferret list, holds the one registration status,
 * and hands them to `ProjectsHub`. Everything a reader can see is in the hub, which takes plain values — so the
 * screenshot harness and the unit tier mount the shipped component rather than a stand-in, and neither needs a store.
 *
 * WHY IT READS THE FERRET LIST AT ALL. A discovery is a folder a FERRET used that no registered project covers, so the
 * unregistered set cannot be derived from the registry alone. `discoveriesFrom` owns that derivation, including the
 * fold-away rule, so the hub and every picker can never disagree about which folders are unregistered.
 *
 * DAEMON SCOPING. The client is bound to one daemon and credential, and the registration status is dropped whenever the
 * client changes: a refusal from the laptop must never be read as the workstation's answer, and a success notice naming
 * a path that only exists on one machine is worse than no notice. A successful write refreshes THIS daemon's slice and
 * nothing else.
 */

import { useRouter } from '@ferretry/app';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RegisterProjectRequest } from '../../contract/index.ts';
import { useProjectsSlice } from '../hooks/use-projects.ts';
import { type ProjectsClient, reasonOf } from '../lib/client.ts';
import { discoveriesFrom } from '../lib/discoveries.ts';
import { type FerretRow, readFerrets } from '../lib/ferrets.ts';
import { projectPath } from '../lib/paths.ts';
import { alreadyRegistered, registerProject } from '../lib/projects-api.ts';
import type { ProjectRegistrationStatus } from '../lib/registration-model.ts';
import { projectsStoreFor } from './context.ts';
import { ProjectsHub } from './projects-hub.tsx';

export function ProjectsPage({ client, daemon }: { readonly client: ProjectsClient; readonly daemon: string }) {
  const store = projectsStoreFor(client);
  const { navigate } = useRouter();
  const slice = useProjectsSlice(store);
  const [ferrets, setFerrets] = useState<{
    readonly rows: readonly FerretRow[] | null;
    readonly error: string | null;
  }>({ rows: null, error: null });
  const [status, setStatus] = useState<ProjectRegistrationStatus | null>(null);

  // Discoveries are a claim about ferrets, so the page that shows them reads them. A failed read is a status the hub
  // states, never a rethrow.
  useEffect(() => {
    let current = true;
    void readFerrets(client)
      .then(rows => {
        if (current) setFerrets({ rows, error: null });
      })
      .catch((cause: unknown) => {
        if (current) setFerrets(previous => ({ rows: previous.rows, error: reasonOf(cause) }));
      });
    return () => {
      current = false;
    };
  }, [client]);

  /**
   * A STATUS BELONGS TO THE CLIENT IT WAS PRODUCED AGAINST. Switching daemons without a remount would otherwise leave
   * one machine's refusal on another's screen. Dropped DURING the render that changes client rather than in an effect,
   * so the other daemon's notice is never painted at all (React's adjust-state-on-prop-change pattern).
   */
  const [statusOwner, setStatusOwner] = useState<ProjectsClient>(client);
  if (statusOwner !== client) {
    setStatusOwner(client);
    setStatus(null);
  }

  // The client currently on screen, for a write that settles after the props moved on. `useLayoutEffect` because a
  // passive effect leaves a window between commit and sync in which a settling write would read a client this page
  // has already left.
  const onScreen = useRef(client);
  useLayoutEffect(() => {
    onScreen.current = client;
  }, [client]);

  const discoveries = discoveriesFrom(ferrets.rows, slice.projects);

  /**
   * One write, fenced by the client it was issued with. A registration is the one thing here that outlives a render:
   * the route is synchronous, so a clone can hold this request open for minutes while the shell hands this page a
   * different daemon. Everything after the await is abandoned unless the client is still the one on screen. An
   * abandoned write answers `false`, which keeps the draft: it is not a claim the daemon refused it, it is the honest
   * reading of "this app can no longer tell you what happened".
   */
  const register = async (request: RegisterProjectRequest): Promise<boolean> => {
    const issued = client;
    setStatus({ phase: 'submitting', request });
    try {
      const project = await registerProject(issued, request);
      if (onScreen.current !== issued) return false;
      // Compared against the rows read BEFORE the write, which is the only moment "this folder was already
      // registered" is answerable.
      setStatus({
        phase: 'registered',
        request,
        project,
        alreadyRegistered: alreadyRegistered(store.projects(), project),
      });
      await store.refresh().catch(() => {});
      return true;
    } catch (reason) {
      if (onScreen.current !== issued) return false;
      setStatus({ phase: 'refused', request, message: reasonOf(reason) });
      return false;
    }
  };

  return (
    <ProjectsHub
      slice={slice}
      discoveries={discoveries}
      ferretsError={ferrets.error}
      status={status}
      onRegister={register}
      onDismiss={() => setStatus(null)}
      projectHref={projectId => projectPath(daemon, projectId)}
      onNavigate={navigate}
      now={Date.now()}
    />
  );
}
