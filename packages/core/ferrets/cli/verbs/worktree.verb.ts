import { WorktreeController } from '../lib/worktrees/controller.ts';
import { resolve } from 'node:path';
import { ClientWorktreeGateway } from '../lib/worktrees/gateway.ts';
import { PROJECTS_ROUTE, resolveProjectGroup } from '../lib/worktrees/project-group.ts';
import { on, text } from '../lib/verb-io.ts';
import { defineVerbs } from './context.ts';

export default defineVerbs(({ client, environment, verb, json, first }) => {
  const worktrees = (io: ConstructorParameters<typeof WorktreeController>[1]) =>
    new WorktreeController(
      new ClientWorktreeGateway(client),
      io,
      { ask: async () => '' },
      false,
      environment.cwd ?? '/',
    );
  const list = verb(async (invocation, _presenter, io) => {
    await worktrees(io).list(json(invocation));
  });
  const check = verb(async (invocation, _presenter, io) => {
    await worktrees(io).check(first(invocation, 'worktree path'), json(invocation));
  });
  const remove = verb(async (invocation, _presenter, io) => {
    await worktrees(io).remove(first(invocation, 'worktree path'), {
      ...(on(invocation, 'discard-changes') ? { discardChanges: true } : {}),
      ...(on(invocation, 'accept-unpushed') ? { acceptUnpushed: true } : {}),
      ...(on(invocation, 'delete-unmerged') ? { deleteUnmerged: true } : {}),
      ...(on(invocation, 'delete-branch') ? { deleteBranch: true } : {}),
      ...(on(invocation, 'delete-preexisting') ? { deletePreexisting: true } : {}),
      ...(on(invocation, 'yes', 'y') ? { yes: true } : {}),
      ...json(invocation),
    });
  });
  const fork = verb(async (invocation, _presenter, io) => {
    const base = text(invocation, 'base');
    const from = text(invocation, 'from');
    const session = text(invocation, 'session');
    const project = text(invocation, 'project');
    const group =
      project === undefined
        ? undefined
        : await resolveProjectGroup(project, async () => await client.call(PROJECTS_ROUTE));
    await worktrees(io).fork(first(invocation, 'branch'), {
      ...(base === undefined ? {} : { base }),
      ...(on(invocation, 'from-default') ? { fromDefault: true } : {}),
      ...(on(invocation, 'from-head') ? { fromHead: true } : {}),
      ...(from === undefined ? {} : { from }),
      ...(session === undefined ? {} : { session }),
      ...(group === undefined ? {} : { group }),
      ...json(invocation),
    });
  });
  return {
    'worktree adopt <path>': verb(async (invocation, _presenter, io) => {
      const adopted = await new ClientWorktreeGateway(client).adopt({
        path: resolve(environment.cwd ?? '/', first(invocation, 'worktree path')),
      });
      io.success(
        json(invocation).json
          ? JSON.stringify(adopted, null, 2)
          : `Adopted ${adopted.worktree.path} (branch ${adopted.worktree.branch}).`,
      );
    }),
    worktree: list,
    worktrees: list,
    'worktree ls': list,
    'worktree list': list,
    'worktree check <path>': check,
    'worktree rm <path>': remove,
    'worktree remove <path>': remove,
    'worktree fork <branch>': fork,
    'worktree add <branch>': fork,
  };
});
