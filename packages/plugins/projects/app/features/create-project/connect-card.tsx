/**
 * "Connect a GitHub account", inside the create flow: Git accounts' own card, not a copy of it.
 *
 * The consent words, the code to type at GitHub, the quiet polls and the passkey press are Git accounts' to draw, so this
 * flow mounts what that plugin provides for `projects.connect-account` (`PROJECTS_CONNECT_ACCOUNT_HOOK`; the page reads
 * it and hands it down). Without a provider (Git accounts off on that machine) the flow says so and everything else in it
 * still works.
 */
import { type ComponentType, createElement } from 'react';
import type { ProjectsConnectAccount, ProjectsConnectAccountProps } from '../../../contract/index.ts';

export interface ConnectCardProps extends ProjectsConnectAccountProps {
  /** What Git accounts provides on this machine, or `undefined` when nothing does. */
  readonly provided: ProjectsConnectAccount | undefined;
}

export function ConnectCard({ provided, connected, onConnected }: ConnectCardProps) {
  if (provided === undefined)
    return (
      <p className="m-0 text-meta text-faint" data-connect-account="unavailable">
        Connecting a GitHub account is not available on this machine. Turn on the Git accounts plugin to connect one.
      </p>
    );
  return createElement(provided.panel as ComponentType<ProjectsConnectAccountProps>, { connected, onConnected });
}
