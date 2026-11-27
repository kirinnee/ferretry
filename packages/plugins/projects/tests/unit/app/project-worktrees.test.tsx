import { describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, RouterProvider, settleUntil } from '@ferretry/app/testing';
import { type ProjectInfo, ProjectInfoSchema } from '../../../contract/index.ts';
import { ProjectDetailPage } from '../../../app/views/project-detail.tsx';
import { type Call, clickEvent, PROJECT, refusal, SWITCH_OFF, scripted } from './support/client.ts';
import { answerFor, FILES, summaryOf } from './support/finder-fixtures.ts';
import { ADOPT, ANSWERS, LIST, listAnswer, row } from './support/worktree-fixtures.ts';

const TWO: ProjectInfo = ProjectInfoSchema.parse({
  ...PROJECT,
  repos: ['site', 'docs'].map(path => ({ path, remote: `https://github.com/fake-org/${path}`, provider: 'github' })),
});

const page = (extra: Record<string, unknown>, calls: Call[], project: ProjectInfo = TWO) =>
  scripted(
    {
      'GET /v1/projects': () => [project],
      'GET /v1/ferrets': [],
      'GET /v1/board/projects/:projectId/switch': SWITCH_OFF,
      [FILES]: (call: Call) => answerFor(summaryOf(), call.query?.q, Number(call.query?.limit ?? 50)),
      [LIST]: (call: Call) => listAnswer(call.query?.commonDir ?? '', ANSWERS[call.query?.commonDir ?? ''] ?? []),
      ...extra,
    },
    calls,
  );

const open = async (client: ReturnType<typeof scripted>): Promise<Mounted> => {
  const mounted = await mount(
    <RouterProvider>
      <ProjectDetailPage client={client} daemon="workstation" projectId={PROJECT.id} />
    </RouterProvider>,
  );
  await settleUntil(
    () => mounted.container.querySelector('[data-project-worktrees]') !== null,
    'the branches and worktrees section',
    interact,
  );
  return mounted;
};

const ready = async (mounted: Mounted): Promise<void> =>
  await settleUntil(
    () => mounted.container.querySelectorAll('[data-project-worktree-state="ready"]').length === 2,
    'both repositories read',
    interact,
  );

describe('the project page: Branches & worktrees (F-120, F-121)', () => {
  it('F-120: lists the branches and worktrees of every repository the project holds', async () => {
    const calls: Call[] = [];
    const mounted = await open(page({}, calls));
    await ready(mounted);
    const rows = [...mounted.container.querySelectorAll('[data-project-worktree]')].map(node =>
      node.getAttribute('data-project-worktree'),
    );
    expect(rows).toEqual([
      '/work/ferretry/site',
      '/work/trees/site-nav',
      '/work/ferretry/docs',
      '/home/fake/old-docs-checkout',
    ]);
    const text = mounted.container.textContent ?? '';
    for (const branch of ['main', 'feat/nav', 'trunk', 'docs/old-fix']) expect(text).toContain(branch);
    expect(text).toContain('uncommitted changes');
    expect(text).toContain('2 ahead');
    expect(text).toContain('5 behind');
    expect(calls.filter(call => call.route === LIST).map(call => call.query)).toEqual([
      { commonDir: '/work/ferretry/site/.git' },
      { commonDir: '/work/ferretry/docs/.git' },
    ]);
    await mounted.unmount();
  });

  it('F-121: offers to adopt only a stray checkout, never a tracked one or the main checkout', async () => {
    const mounted = await open(page({}, []));
    await ready(mounted);
    const offers = [...mounted.container.querySelectorAll('[data-project-worktree-offer]')].map(node =>
      node.getAttribute('data-project-worktree-offer'),
    );
    expect(offers).toEqual(['/home/fake/old-docs-checkout']);
    expect(mounted.container.textContent).toContain('exactly where it is');
    await mounted.unmount();
  });

  it('F-121: adopting sends the checkout’s path, then reads the repository again', async () => {
    const calls: Call[] = [];
    const adopted = new Set<string>();
    const mounted = await open(
      page(
        {
          [ADOPT]: (call: Call) => {
            adopted.add((call.body as { path: string }).path);
            return {};
          },
          [LIST]: (call: Call) => {
            const dir = call.query?.commonDir ?? '';
            return listAnswer(
              dir,
              (ANSWERS[dir] ?? []).map(r =>
                adopted.has(r.path) ? row(r.path, r.live.branch ?? '', { tracked: 'adopted' }) : r,
              ),
            );
          },
        },
        calls,
      ),
    );
    await ready(mounted);
    await interact(() =>
      must(mounted.container.querySelector('[data-project-worktree-adopt]'), 'the adopt button').dispatchEvent(
        clickEvent(),
      ),
    );
    await settleUntil(
      () => mounted.container.querySelector('[data-project-worktree-offer]') === null,
      'the offer gone after adoption',
      interact,
    );
    expect(calls.filter(call => call.route === ADOPT).map(call => call.body)).toEqual([
      { path: '/home/fake/old-docs-checkout' },
    ]);
    expect(
      mounted.container
        .querySelector('[data-project-worktree="/home/fake/old-docs-checkout"]')
        ?.getAttribute('data-project-worktree-tracked'),
    ).toBe('adopted');
    await mounted.unmount();
  });

  it('quotes the daemon’s refusal of an adoption and keeps the offer', async () => {
    const mounted = await open(page({ [ADOPT]: refusal(409, 'that checkout is in use.', 'worktree_busy') }, []));
    await ready(mounted);
    await interact(() =>
      must(mounted.container.querySelector('[data-project-worktree-adopt]'), 'the adopt button').dispatchEvent(
        clickEvent(),
      ),
    );
    await settleUntil(
      () => mounted.container.querySelector('[data-project-worktree-refused]') !== null,
      'the refusal',
      interact,
    );
    expect(mounted.container.querySelector('[data-project-worktree-refused]')?.textContent).toContain(
      'that checkout is in use.',
    );
    expect(mounted.container.querySelector('[data-project-worktree-offer]')).not.toBeNull();
    await mounted.unmount();
  });

  it('says a repository could not be read instead of calling it empty, and still draws the other one', async () => {
    const mounted = await open(
      page(
        {
          [LIST]: (call: Call) => {
            if (call.query?.commonDir === '/work/ferretry/docs/.git') throw refusal(422, 'not a git common directory.');
            return listAnswer(call.query?.commonDir ?? '', ANSWERS[call.query?.commonDir ?? ''] ?? []);
          },
        },
        [],
      ),
    );
    await settleUntil(
      () => mounted.container.querySelector('[data-project-worktree-state="failed"]') !== null,
      'the failed repository',
      interact,
    );
    expect(mounted.container.querySelector('[data-project-worktree-state="failed"]')?.textContent).toContain(
      'not a git common directory.',
    );
    expect(mounted.container.querySelector('[data-project-worktree="/work/trees/site-nav"]')).not.toBeNull();
    await mounted.unmount();
  });

  it('MUST 1: lists a project whose record has a common directory but no saved repositories (repos absent)', async () => {
    const calls: Call[] = [];
    const own = ProjectInfoSchema.parse({ ...PROJECT, git: { commonDirectory: '/work/ferretry/.git' } });
    const mounted = await mount(
      <RouterProvider>
        <ProjectDetailPage
          client={page(
            {
              [LIST]: () =>
                listAnswer('/work/ferretry/.git', [
                  row('/work/ferretry', 'main', { main: true, tracked: 'none' }),
                  row('/work/trees/nav', 'feat/nav'),
                ]),
            },
            calls,
            own,
          )}
          daemon="workstation"
          projectId={PROJECT.id}
        />
      </RouterProvider>,
    );
    await settleUntil(
      () => mounted.container.querySelectorAll('[data-project-worktree]').length === 2,
      'both worktrees listed',
      interact,
    );
    expect(mounted.container.querySelector('[data-project-worktrees="none"]')).toBeNull();
    // R2-1: the project's own repository is asked about by the project's id; the daemon owns the directory.
    expect(calls.filter(call => call.route === LIST).map(call => call.query)).toEqual([{ project: PROJECT.id }]);
    await mounted.unmount();
  });

  it('MUST 2: a project that is itself a linked checkout asks its recorded common directory, never its own .git file', async () => {
    const calls: Call[] = [];
    const linked = ProjectInfoSchema.parse({
      ...PROJECT,
      git: { commonDirectory: '/work/main/.git' },
      repos: [{ path: '.' }],
    });
    const mounted = await mount(
      <RouterProvider>
        <ProjectDetailPage
          client={page(
            {
              [LIST]: (call: Call) =>
                call.query?.project === PROJECT.id
                  ? listAnswer('/work/main/.git', [
                      row('/work/main', 'main', { main: true, tracked: 'none' }),
                      row('/work/ferretry', 'feat/this'),
                    ])
                  : refusal(422, 'not a git common directory.'),
            },
            calls,
            linked,
          )}
          daemon="workstation"
          projectId={PROJECT.id}
        />
      </RouterProvider>,
    );
    await settleUntil(
      () => mounted.container.querySelectorAll('[data-project-worktree]').length === 2,
      'main and linked branches listed',
      interact,
    );
    expect(mounted.container.querySelector('[data-project-worktree-state="failed"]')).toBeNull();
    expect(calls.filter(call => call.route === LIST).map(call => call.query)).toEqual([{ project: PROJECT.id }]);
    await mounted.unmount();
  });

  it('MUST 2: a repository found inside the folder that is a linked checkout of a listed one is folded into it, not drawn as failed', async () => {
    const nested = ProjectInfoSchema.parse({ ...PROJECT, repos: [{ path: 'site' }, { path: 'site-wt' }] });
    const mounted = await open(
      page(
        {
          [LIST]: (call: Call) =>
            call.query?.commonDir === '/work/ferretry/site/.git'
              ? listAnswer('/work/ferretry/site/.git', [
                  row('/work/ferretry/site', 'main', { main: true, tracked: 'none' }),
                  row('/work/ferretry/site-wt', 'feat/wt'),
                ])
              : refusal(422, 'not a git common directory.'),
        },
        [],
        nested,
      ),
    );
    await settleUntil(
      () => mounted.container.querySelectorAll('[data-project-worktree]').length === 2,
      'the listed repository',
      interact,
    );
    await settleUntil(
      () => mounted.container.querySelectorAll('[data-project-worktree-repo]').length === 1,
      'the folded repository gone',
      interact,
    );
    expect(mounted.container.querySelector('[data-project-worktree-state="failed"]')).toBeNull();
    await mounted.unmount();
  });

  it('SHOULD 3: a detached or missing stray checkout gets the reason instead of an Adopt button the daemon would refuse', async () => {
    const mounted = await open(
      page(
        {
          [LIST]: (call: Call) =>
            listAnswer(call.query?.commonDir ?? '', [
              row('/work/a/main', 'main', { main: true, tracked: 'none' }),
              row('/work/a/detached', '', { tracked: 'none', live: { branch: undefined, detached: true } }),
              row('/work/a/gone', 'old', {
                tracked: 'none',
                live: { prunable: 'gitdir file points to non-existent location' },
              }),
              row('/work/a/fine', 'fine', { tracked: 'none' }),
            ]),
        },
        [],
      ),
    );
    await ready(mounted);
    const offers = [...mounted.container.querySelectorAll('[data-project-worktree-adopt]')].map(node =>
      node.getAttribute('data-project-worktree-adopt'),
    );
    expect(offers).toEqual(['/work/a/fine', '/work/a/fine']);
    const reasons = [...mounted.container.querySelectorAll('[data-project-worktree-no-adopt]')].map(node => [
      node.getAttribute('data-project-worktree-no-adopt'),
      node.textContent,
    ]);
    expect(reasons).toHaveLength(4);
    expect(String(reasons[0]?.[1])).toContain('detached HEAD');
    expect(String(reasons[1]?.[1])).toContain('missing on disk');
    await mounted.unmount();
  });

  it('says so when the project holds no repository', async () => {
    const mounted = await open(page({}, [], PROJECT));
    expect(mounted.container.querySelector('[data-project-worktrees="none"]')).not.toBeNull();
    await mounted.unmount();
  });
});
