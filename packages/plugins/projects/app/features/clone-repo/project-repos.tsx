/**
 * THE PROJECT'S REPOSITORIES, and the one way to add another: clone it into the project's folder.
 *
 * The list is the registry's own (`project.repos`, kept by every scan), so a repository the daemon cloned shows up through
 * the same read that every other screen uses; this panel keeps no list of its own. The clone is synchronous on the
 * daemon (the same one the create flow runs), so the wait is said before the press and the daemon's refusal is quoted as
 * it worded it, with the address kept for a second try.
 */
import { Spinner } from '@ferretry/app/ui';
import { TriangleAlert } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import {
  cloneAddressHasCredentials,
  CloneRepoCredentialsMessage,
  CloneRepoRequestSchema,
  type ProjectInfo,
} from '../../../contract/index.ts';
import type { ProjectsClient } from '../../lib/client.ts';
import { reasonOf } from '../../lib/client.ts';
import { CLONE_ADDRESS_UNUSABLE, CLONE_PATIENCE } from '../../lib/registration-model.ts';
import { cloneRepo } from './clone-repo-api.ts';

export function ProjectRepos({
  client,
  project,
  onCloned,
}: {
  readonly client: ProjectsClient;
  readonly project: ProjectInfo;
  /** Called after the daemon cloned and kept the repository: the page reads the registry again. */
  readonly onCloned: () => void;
}) {
  const urlId = useId();
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<
    { readonly kind: 'idle' } | { readonly kind: 'busy' } | { readonly kind: 'refused'; readonly message: string }
  >({ kind: 'idle' });
  const repos = project.repos ?? [];
  const typed = url.trim();
  const parsed = CloneRepoRequestSchema.safeParse({ url: typed });
  const usable = parsed.success;
  const busy = phase.kind === 'busy';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!usable || busy) return;
    setPhase({ kind: 'busy' });
    cloneRepo(client, project.id, typed).then(
      () => {
        setUrl('');
        setPhase({ kind: 'idle' });
        onCloned();
      },
      (cause: unknown) => setPhase({ kind: 'refused', message: reasonOf(cause) }),
    );
  };

  return (
    <div className="grid gap-sm" data-project-repos={repos.length === 0 ? 'none' : 'some'}>
      {repos.length === 0 ? (
        <p className="m-0 text-meta text-faint">No repository has been found in this project’s folder yet.</p>
      ) : (
        <ul className="m-0 grid list-none gap-xs p-0">
          {repos.map(repo => (
            <li
              className="grid min-w-0 gap-0.5 rounded-panel border border-border-strong bg-surface-2 px-panel py-2"
              key={repo.path}
              data-project-repo={repo.path}
            >
              <span className="mono truncate text-ui font-medium text-fg">{repo.path}</span>
              {repo.remote !== undefined && <span className="mono truncate text-2xs text-muted">{repo.remote}</span>}
            </li>
          ))}
        </ul>
      )}
      <form className="grid gap-xs" onSubmit={submit} aria-label="Clone another repository into this project">
        <label className="grid min-w-0 gap-1 text-ui text-muted" htmlFor={urlId}>
          Clone another repository
          <input
            id={urlId}
            data-project-clone-url=""
            className="kt-input mono min-h-control w-full"
            value={url}
            placeholder="https://github.com/you/project.git"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={event => {
              if (cloneAddressHasCredentials(event.target.value)) {
                event.target.value = '';
                setUrl('');
                setPhase({ kind: 'refused', message: CloneRepoCredentialsMessage });
                return;
              }
              setUrl(event.target.value);
              if (phase.kind === 'refused') setPhase({ kind: 'idle' });
            }}
          />
        </label>
        {typed !== '' && !usable && (
          <p className="m-0 text-meta leading-base text-warn">
            {parsed.error?.issues[0]?.message ?? CLONE_ADDRESS_UNUSABLE}
          </p>
        )}
        <p className="m-0 text-meta leading-base text-muted">{CLONE_PATIENCE}</p>
        {phase.kind === 'refused' && (
          <p className="m-0 flex items-start gap-xs text-meta text-err" role="alert" data-project-clone-refused="">
            <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
            <span>This daemon refused it: {phase.message}</span>
          </p>
        )}
        <button
          className="kt-btn min-h-control w-fit"
          data-variant="primary"
          data-project-clone-submit=""
          type="submit"
          disabled={!usable || busy}
        >
          {busy ? <Spinner /> : null}
          {busy ? 'Cloning…' : 'Clone into project'}
        </button>
      </form>
    </div>
  );
}
