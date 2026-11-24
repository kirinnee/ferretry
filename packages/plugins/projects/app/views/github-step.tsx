/**
 * THE SETUP FLOW'S "CONNECT GITHUB" PAGE (`projects.github`, a device page right after "Add your projects"): the SAME
 * "Connect a GitHub account" card the Create-a-project flow and the Git accounts tab draw (`projects.connect-account`: the
 * consent words, the code to type at GitHub, the quiet polls, the passkey press), not a copy and not a second sign-in. The
 * flow draws the title, the footer ("Skip for now" is its Later button) and the loading cover; this page draws only the body.
 *
 * - It shows the accounts already connected (logins only: a token never reaches a browser) and the card to add another.
 * - A machine that wants the passkey before it LISTS the accounts never walls the page: the card to connect is always
 *   there, and the list is one quiet "confirm" button below it.
 * - When the page before it PROVED it made exactly one project (`linkProjectId`, `linkProjectName` in the step's memory), each
 *   connected account can be ticked to link to that project, and Next saves the link. Every tick is the person's own, visible
 *   and unticked to begin with (connecting an account ticks nothing); Next adds the ticked accounts to the project's list as it
 *   stands (read, merge, write) and never replaces it. Nothing ticked: Next just moves on and sends nothing.
 * - Git accounts off on this machine: the page says so and the way out is still "Skip for now".
 */
import { daemonOfClient, useAppHook } from '@ferretry/app';
import { ConfirmToSee } from '@ferretry/app/ui';
import type { StepHost } from '@ferretry/kernel/contract';
import type { AppComponent, PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  isProjectsConnectAccount,
  PROJECTS_CONNECT_ACCOUNT_HOOK,
  type ProjectsConnectAccount,
} from '../../contract/index.ts';
import { setProjectAccounts } from '../features/create-project/accounts-api.ts';
import { ConnectCard } from '../features/create-project/connect-card.tsx';
import { useGitAccounts } from '../features/create-project/use-git-accounts.ts';
import { type ProjectsClient, reasonOf } from '../lib/client.ts';
import { fetchProjects } from '../lib/projects-api.ts';

export interface GithubStepProps {
  readonly step: StepHost | undefined;
  readonly client: ProjectsClient;
  /** Git accounts' connect card, when this machine has it. */
  readonly connectAccount: ProjectsConnectAccount | undefined;
}

/** The one project the page before made, if it made exactly one: what the accounts can be linked to. */
const projectOf = (step: StepHost | undefined): { readonly id: string; readonly name: string } | undefined => {
  const id = step?.segment.linkProjectId;
  const name = step?.segment.linkProjectName;
  return typeof id === 'string' && id !== '' && typeof name === 'string' ? { id, name } : undefined;
};

export function GithubStep({ step, client, connectAccount }: GithubStepProps) {
  const accounts = useGitAccounts(client);
  const host = useRef(step);
  host.current = step;
  const project = projectOf(step);
  const [linked, setLinked] = useState<readonly string[]>([]);
  // Accounts connected on this page, for the words below when the machine will not list them without the passkey.
  const [justConnected, setJustConnected] = useState(0);

  // The page is drawn once the first read has answered either way: a refusal or a failure never holds the cover.
  const answered = accounts.accounts !== null || accounts.error !== null;
  useEffect(() => {
    if (answered) host.current?.ready();
  }, [answered]);

  // What Next saves: the ticked accounts added to the one project, when something visible is ticked; otherwise Next only moves on.
  const projectId = project?.id;
  const visible = (accounts.accounts ?? []).map(account => account.id);
  // The ticked accounts the page still lists, as one string so the save below is rebuilt exactly when the set changes.
  const tickedKey = linked.filter(id => visible.includes(id)).join(',');
  useEffect(() => {
    const ticked = tickedKey === '' ? [] : tickedKey.split(',');
    if (projectId === undefined || ticked.length === 0) return host.current?.commit(null);
    host.current?.commit(async () => {
      try {
        // The project may already hold accounts: add to its list as it stands now, never replace it.
        const row = (await fetchProjects(client)).find(each => each.id === projectId);
        if (row === undefined) throw new Error('that project is no longer registered');
        const merged = [...(row.accounts ?? []), ...ticked.filter(id => !(row.accounts ?? []).includes(id))];
        await setProjectAccounts(client, projectId, merged);
      } catch (cause) {
        throw new Error(`The link was not saved: ${reasonOf(cause)}`);
      }
    });
  }, [client, projectId, tickedKey]);

  const connected = (): void => {
    setJustConnected(count => count + 1);
    accounts.reload();
  };
  const toggle = (id: string, on: boolean): void =>
    setLinked(known => (on ? (known.includes(id) ? known : [...known, id]) : known.filter(each => each !== id)));

  const rows = accounts.accounts ?? [];
  return (
    <div className="grid gap-md" data-projects-step="github">
      <p className="m-0 text-ui text-muted">
        Ferrets push and sign commits as a GitHub account. Connect one or several here, or skip and do it later from
        Settings or a project&apos;s own page.
      </p>
      {rows.length > 0 ? (
        <div className="grid gap-xs" data-github-accounts="">
          <p className="m-0 text-meta text-muted">Connected accounts</p>
          <ul className="m-0 grid list-none divide-y divide-border-soft p-0" aria-label="Connected GitHub accounts">
            {rows.map(account => (
              <li key={account.id} data-github-account={account.id}>
                {project === undefined ? (
                  <span className="flex min-h-control items-center text-ui">@{account.login}</span>
                ) : (
                  <label className="flex min-h-control cursor-pointer items-center gap-sm py-1 text-ui">
                    <input
                      type="checkbox"
                      className="size-4 accent-accent"
                      checked={linked.includes(account.id)}
                      onChange={event => toggle(account.id, event.target.checked)}
                    />
                    <span className="min-w-0 truncate">
                      Use @{account.login} for {project.name}
                    </span>
                  </label>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : accounts.accounts !== null ? (
        <p className="m-0 text-meta text-faint" data-github-empty="">
          No GitHub account is connected on this machine yet.
        </p>
      ) : null}
      <ConnectCard provided={connectAccount} connected={rows.length || justConnected} onConnected={connected} />
      {accounts.stepUp ? (
        <div data-github-step-up="">
          <ConfirmToSee
            line={
              justConnected > 0
                ? 'Connected. This machine wants your passkey before it lists its GitHub accounts.'
                : 'Connected one before? This machine wants your passkey before it lists its GitHub accounts.'
            }
            onConfirm={accounts.confirm}
          />
        </div>
      ) : (
        accounts.error !== null && (
          <p className="m-0 flex items-start gap-xs text-meta text-warn" role="status" data-github-error="">
            <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
            Could not read the connected accounts: {accounts.error}
          </p>
        )
      )}
    </div>
  );
}

/** The panel Projects places in `onboarding.step` for `projects.github`: this machine's connect card is read here. */
export function createGithubStep(client: PluginClient): AppComponent<PanelProps> {
  const daemon = daemonOfClient(client);
  return function GithubStepPanel(props: PanelProps) {
    const provided = useAppHook(daemon ?? '', PROJECTS_CONNECT_ACCOUNT_HOOK);
    return (
      <GithubStep
        step={props.step}
        client={client}
        connectAccount={isProjectsConnectAccount(provided) ? provided : undefined}
      />
    );
  };
}
