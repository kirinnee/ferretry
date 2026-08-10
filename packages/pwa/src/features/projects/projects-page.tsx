/**
 * ONE DAEMON'S REGISTRY, BOUND TO THE STORES THAT OWN ITS FACTS.
 *
 * This half is deliberately thin: it reads two slices, holds the one registration
 * status, and hands both to `ProjectsHub`. Everything a reader can see is in the
 * hub, which takes plain values — so the screenshot harness and the unit tier
 * mount the shipped component rather than a stand-in, and neither needs a store.
 *
 * WHY IT READS THE SESSION LIST AT ALL. A discovery is a folder a SESSION used
 * that no registered project covers, so the unregistered set cannot be derived
 * from the registry alone. `projectPickerOptions` already owns that derivation for
 * the new-session folder picker — including the fold-away rule, which delegates to
 * the same `projectKeyFor` session grouping uses — and this page calls it rather
 * than writing a second rule that could disagree with the picker about which
 * folders are unregistered.
 *
 * DAEMON SCOPING. Every read names this connection's `DaemonId`, and the
 * registration status is dropped whenever the daemon changes: a refusal from the
 * laptop must never be read as the workstation's answer, and a success notice
 * naming a path that only exists on one machine is worse than no notice. A
 * successful write refreshes THIS daemon's project slice and nothing else — a
 * folder registered here says nothing about any other daemon's registry.
 */

import type { RegisterProjectRequest } from '@ferretry/protocol';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { projectPickerOptions } from '../../components/daemon-picker-model.ts';
import { useProjectsSlice } from '../../hooks/use-projects.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonProjectPath } from '../../lib/pages/routes.ts';
import { useRouter } from '../../lib/router.tsx';
import { useAppStore } from '../../lib/store.tsx';
import type { ProjectRegistrationStatus } from './project-registration-model.ts';
import { alreadyRegistered, registerProject } from './projects-api.ts';
import { ProjectsHub } from './projects-hub.tsx';

const failureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/**
 * The whole credential, not just the daemon id.
 *
 * A `DaemonId` alone does not identify a connection: a re-pair keeps the id and
 * replaces the base URL or the device token, and an answer obtained under the
 * replaced credential is exactly as wrong as an answer from a different machine.
 * `projects-store.ts` draws its own boundary the same way, and this has to agree
 * with it or a write settling late would hand the store the stale connection.
 */
const sameConnection = (left: DaemonConnection, right: DaemonConnection): boolean =>
  left.daemonId === right.daemonId && left.baseUrl === right.baseUrl && left.deviceToken === right.deviceToken;

/** The same identity as one comparable value, for the render that has to notice it changed. */
const credentialKey = (connection: DaemonConnection): string =>
  JSON.stringify([connection.daemonId, connection.baseUrl, connection.deviceToken]);

export function ProjectsPage({ connection }: { readonly connection: DaemonConnection }) {
  const { projects, fleet } = useAppStore();
  const { navigate } = useRouter();
  const slice = useProjectsSlice(projects, connection);
  const subscribeFleet = useCallback((listener: () => void) => fleet.subscribe(listener), [fleet]);
  const fleetSnapshot = useCallback(() => fleet.getSnapshot(), [fleet]);
  const snapshot = useSyncExternalStore(subscribeFleet, fleetSnapshot);
  const [status, setStatus] = useState<ProjectRegistrationStatus | null>(null);

  // Discoveries are a claim about sessions, so the page that shows them reads
  // them. A failed read is a status the hub states, never a rethrow.
  useEffect(() => {
    void fleet.hydrate(connection).catch(() => {});
  }, [fleet, connection]);

  /**
   * A STATUS BELONGS TO THE CONNECTION IT WAS PRODUCED AGAINST, credential
   * included. Switching daemons without a remount would otherwise leave one
   * machine's refusal on another's screen, and a re-pair keeps the id while
   * replacing the token — which `scripts/validate/daemon-scope.sh` exists to make
   * unthinkable.
   *
   * Dropped DURING the render that changes connection rather than in an effect,
   * so the other daemon's notice is never painted at all. React's own
   * adjust-state-on-prop-change pattern: the extra render happens before the
   * browser sees anything.
   */
  const [statusOwner, setStatusOwner] = useState(credentialKey(connection));
  const owner = credentialKey(connection);
  if (statusOwner !== owner) {
    setStatusOwner(owner);
    setStatus(null);
  }

  // The connection currently on screen, for a write that settles after the props
  // moved on. A ref rather than the closure: `register` has to compare against
  // NOW, and its own `connection` is the one it was issued with. `useLayoutEffect`
  // because a passive effect leaves a window between commit and sync in which a
  // settling write would read the connection this page has already left.
  const onScreen = useRef(connection);
  useLayoutEffect(() => {
    onScreen.current = connection;
  }, [connection]);

  const fleetSlice = snapshot.daemons.get(connection.daemonId);
  const catalog = projectPickerOptions(slice.projects, fleetSlice?.sessions ?? null);

  /**
   * One write, fenced by the connection it was issued with.
   *
   * A registration is the one thing here that outlives a render: the route is
   * synchronous, so a clone can hold this request open for minutes while the
   * reader re-pairs the daemon or the shell hands this page a different one.
   * Everything after the await is therefore abandoned unless the connection is
   * still the one on screen — otherwise daemon A's refusal would be rendered as
   * daemon B's, and `refresh` would hand the store a connection carrying a
   * credential that has been replaced, whose entry would evict the live one.
   *
   * An abandoned write answers `false`, which keeps the draft. It is not a claim
   * the daemon refused it; it is the honest reading of "this browser can no
   * longer tell you what happened", and losing what somebody typed on top of
   * that would be the worse of the two mistakes.
   */
  const register = async (request: RegisterProjectRequest): Promise<boolean> => {
    const issued = connection;
    setStatus({ phase: 'submitting', request });
    try {
      const project = await registerProject(issued, request);
      if (!sameConnection(onScreen.current, issued)) return false;
      // Compared against the rows read BEFORE the write, which is the only
      // moment "this folder was already registered" is answerable.
      setStatus({
        phase: 'registered',
        request,
        project,
        alreadyRegistered: alreadyRegistered(projects.projects(issued.daemonId), project),
      });
      await projects.refresh(issued).catch(() => {});
      return true;
    } catch (reason) {
      if (!sameConnection(onScreen.current, issued)) return false;
      setStatus({ phase: 'refused', request, message: failureMessage(reason) });
      return false;
    }
  };

  return (
    <ProjectsHub
      slice={slice}
      discoveries={catalog.recent}
      sessionsError={fleetSlice?.error ?? null}
      status={status}
      onRegister={register}
      onDismiss={() => setStatus(null)}
      projectHref={projectId => daemonProjectPath(connection.daemonId, projectId)}
      onNavigate={navigate}
      now={Date.now()}
    />
  );
}
