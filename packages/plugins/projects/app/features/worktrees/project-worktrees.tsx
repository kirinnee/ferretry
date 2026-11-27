/**
 * THE PROJECT'S BRANCHES AND WORKTREES (F-120, F-121): one panel listing, for every repository the project holds, each
 * worktree Git names with its branch and what Git says about it right now, and for a checkout Ferretry has no record of
 * (an old, hand-made one) the offer to adopt it.
 *
 * Projects owns none of the facts: the rows are Ferrets' own repository list, read once per repository. A repository whose
 * list could not be read says so beside its name; it is never drawn as "no worktrees". Adopting keeps the checkout where
 * it is (Ferrets never moves one), so the offer is the one existing in-place act and the list is read again after it.
 */
import { Spinner } from '@ferretry/app/ui';
import { useCallback, useEffect, useState } from 'react';
import type { RepoWorktreeListResponse, RepoWorktreeRow } from '@ferretry/core-ferrets/contract';
import type { ProjectInfo } from '../../../contract/index.ts';
import type { ProjectsClient } from '../../lib/client.ts';
import { reasonOf } from '../../lib/client.ts';
import { adoptWorktree, readRepoWorktrees, repoCommonDirectory } from './worktrees-api.ts';

type Reading =
  | { readonly kind: 'unread' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'ready'; readonly list: RepoWorktreeListResponse };

/** A checkout Git lists that Ferretry holds no record of: the main checkout and a bare repository are never offered. */
const isStray = (row: RepoWorktreeRow): boolean => row.tracked === 'none' && !row.main && !row.bare;

/** The words for what Git says about one checkout; an undetermined fact is not guessed. */
const facts = (row: RepoWorktreeRow): readonly string[] => {
  const { live } = row;
  const status = live.status;
  const dirty =
    status !== undefined &&
    (status.staged || status.unstaged || status.untracked || status.conflicted || status.dirtySubmodule);
  const out: string[] = [];
  if (status === undefined) out.push('state unknown');
  else out.push(dirty ? 'uncommitted changes' : 'clean');
  if (live.ahead !== undefined && live.ahead > 0) out.push(`${live.ahead} ahead`);
  if (live.behind !== undefined && live.behind > 0) out.push(`${live.behind} behind`);
  if (live.integrated === true) out.push('merged');
  if (live.locked !== undefined) out.push('locked');
  if (live.prunable !== undefined) out.push('missing on disk');
  const active = (row.ferrets ?? []).filter(ferret => ferret.active).length;
  if (active > 0) out.push(`${active} ferret${active === 1 ? '' : 's'} working`);
  return out;
};

const TRACKED = { managed: 'Ferretry made it', adopted: 'adopted', none: 'not tracked' } as const;

function Row({
  row,
  busy,
  onAdopt,
}: {
  readonly row: RepoWorktreeRow;
  readonly busy: boolean;
  readonly onAdopt: (path: string) => void;
}) {
  const stray = isStray(row);
  return (
    <li
      className="grid min-w-0 gap-1 rounded-panel border border-border-strong bg-surface-2 px-panel py-2"
      data-project-worktree={row.path}
      data-project-worktree-tracked={row.tracked}
    >
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-sm gap-y-0.5">
        <span className="mono min-w-0 break-all text-ui font-medium text-fg">
          {row.live.branch ?? (row.live.detached ? 'detached HEAD' : 'no branch')}
        </span>
        <span className="text-2xs text-muted">{row.main ? 'main checkout' : TRACKED[row.tracked]}</span>
      </span>
      <span className="mono break-all text-2xs text-muted">{row.path}</span>
      {!row.bare && <span className="text-meta text-muted">{facts(row).join(' · ')}</span>}
      {stray && (
        <span className="grid justify-items-start gap-1" data-project-worktree-offer={row.path}>
          <span className="text-meta leading-base text-muted">
            Ferretry has no record of this old checkout. Adopting it keeps it exactly where it is, so Ferretry can list,
            protect and tidy it.
          </span>
          <button
            className="kt-btn kt-btn--sm"
            type="button"
            data-project-worktree-adopt={row.path}
            disabled={busy}
            onClick={() => onAdopt(row.path)}
          >
            {busy ? <Spinner /> : null}
            {busy ? 'Adopting…' : 'Adopt in place'}
          </button>
        </span>
      )}
    </li>
  );
}

function RepoGroup({
  client,
  commonDir,
  name,
}: {
  readonly client: ProjectsClient;
  readonly commonDir: string;
  readonly name: string;
}) {
  const [reading, setReading] = useState<Reading>({ kind: 'unread' });
  const [adopting, setAdopting] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const read = useCallback(
    (alive: () => boolean) =>
      readRepoWorktrees(client, commonDir).then(
        list => {
          if (alive()) setReading({ kind: 'ready', list });
        },
        (cause: unknown) => {
          if (alive())
            setReading(previous =>
              previous.kind === 'ready' ? previous : { kind: 'failed', reason: reasonOf(cause) },
            );
        },
      ),
    [client, commonDir],
  );
  useEffect(() => {
    let alive = true;
    void read(() => alive);
    return () => {
      alive = false;
    };
  }, [read]);

  const adopt = (path: string): void => {
    setAdopting(path);
    setRefused(null);
    adoptWorktree(client, path).then(
      () => read(() => true).then(() => setAdopting(null)),
      (cause: unknown) => {
        setRefused(reasonOf(cause));
        setAdopting(null);
      },
    );
  };

  return (
    <div className="grid gap-xs" data-project-worktree-repo={name} data-project-worktree-state={reading.kind}>
      <h3 className="m-0 mono break-all text-ui font-semibold text-fg">{name}</h3>
      {reading.kind === 'unread' && <p className="m-0 text-meta text-muted">Reading this repository’s worktrees…</p>}
      {reading.kind === 'failed' && (
        <p className="m-0 text-meta text-warn" role="status">
          Could not read this repository’s worktrees: {reading.reason}
        </p>
      )}
      {reading.kind === 'ready' && (
        <>
          <ul className="m-0 grid list-none gap-xs p-0">
            {reading.list.worktrees.map(row => (
              <Row key={row.path} row={row} busy={adopting === row.path} onAdopt={adopt} />
            ))}
          </ul>
          {reading.list.truncated && (
            <p className="m-0 text-meta text-warn">
              Git lists {reading.list.total} worktrees; only the first {reading.list.worktrees.length} are shown.
            </p>
          )}
        </>
      )}
      {refused !== null && (
        <p className="m-0 text-meta text-err" role="alert" data-project-worktree-refused="">
          This daemon refused it: {refused}
        </p>
      )}
    </div>
  );
}

export function ProjectWorktrees({
  client,
  project,
}: {
  readonly client: ProjectsClient;
  readonly project: ProjectInfo;
}) {
  const repos = project.repos ?? [];
  if (repos.length === 0)
    return (
      <p className="m-0 text-meta text-faint" data-project-worktrees="none">
        No repository has been found in this project’s folder yet, so there are no branches to list.
      </p>
    );
  return (
    <div className="grid gap-panel" data-project-worktrees="some">
      {repos.map(repo => (
        <RepoGroup
          key={repo.path}
          client={client}
          commonDir={repoCommonDirectory(project.path, repo)}
          name={repo.path}
        />
      ))}
    </div>
  );
}
