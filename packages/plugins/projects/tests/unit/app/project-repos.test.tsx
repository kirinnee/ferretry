import { describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, RouterProvider, settleUntil } from '@ferretry/app/testing';
import { type ProjectInfo, ProjectInfoSchema } from '../../../contract/index.ts';
import { ProjectDetailPage } from '../../../app/views/project-detail.tsx';
import { type Call, clickEvent, PROJECT, refusal, SWITCH_OFF, scripted, typeInto } from './support/client.ts';
import { answerFor, FILES, summaryOf } from './support/finder-fixtures.ts';

const CLONE = 'POST /v1/projects/:id/repos';
const URL = 'https://github.com/you/cloned.git';
const withRepos = (...paths: string[]): ProjectInfo =>
  ProjectInfoSchema.parse({
    ...PROJECT,
    repos: paths.map(path => ({ path, remote: `https://github.com/you/${path}`, provider: 'github' })),
  });

const page = (extra: Record<string, unknown>, calls: Call[], registry: () => ProjectInfo) =>
  scripted(
    {
      'GET /v1/projects': () => [registry()],
      'GET /v1/ferrets': [],
      'GET /v1/board/projects/:projectId/switch': SWITCH_OFF,
      [FILES]: (call: Call) => answerFor(summaryOf(), call.query?.q, Number(call.query?.limit ?? 50)),
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
    () => mounted.container.querySelector('[data-project-repos]') !== null,
    'the repositories section',
    interact,
  );
  return mounted;
};

const cloneNow = async (mounted: Mounted, url: string): Promise<void> => {
  const input = must(mounted.container.querySelector<HTMLInputElement>('[data-project-clone-url]'), 'the address');
  await interact(() => typeInto(input, url));
  await interact(() =>
    must(mounted.container.querySelector('[data-project-clone-submit]'), 'the clone button').dispatchEvent(
      clickEvent(),
    ),
  );
};

describe('the project page: Repositories (F-101)', () => {
  it('MUST 3: clears inline credentials immediately, explains Accounts/secrets, and sends nothing', async () => {
    const calls: Call[] = [];
    const mounted = await open(page({}, calls, () => PROJECT));
    await cloneNow(mounted, 'https://fixture-user:fixture-secret@example.invalid/repo.git');
    const input = must(mounted.container.querySelector<HTMLInputElement>('[data-project-clone-url]'), 'the address');
    expect(input.value).toBe('');
    expect(mounted.container.textContent).toContain('Accounts and secrets');
    expect(mounted.container.innerHTML).not.toContain('fixture-secret');
    expect(calls.filter(call => call.route === CLONE)).toEqual([]);
    await mounted.unmount();
  });
  it('lists the repositories the project holds, and says so when it holds none', async () => {
    const some = await open(page({}, [], () => withRepos('app', 'lib')));
    const rows = [...some.container.querySelectorAll('[data-project-repo]')].map(row =>
      row.getAttribute('data-project-repo'),
    );
    expect(rows).toEqual(['app', 'lib']);
    await some.unmount();
    const none = await open(page({}, [], () => PROJECT));
    expect(none.container.querySelector('[data-project-repos="none"]')).not.toBeNull();
    await none.unmount();
  });

  it('clones another repository into the project, then shows the registry’s new list and clears the address', async () => {
    const calls: Call[] = [];
    let held = withRepos('app');
    const client = page(
      {
        [CLONE]: () => {
          held = withRepos('app', 'cloned');
          return { repos: held.repos, truncated: false };
        },
      },
      calls,
      () => held,
    );
    const mounted = await open(client);
    await cloneNow(mounted, URL);
    await settleUntil(
      () => mounted.container.querySelector('[data-project-repo="cloned"]') !== null,
      'the new repository',
      interact,
    );
    const sent = calls.filter(call => call.route === CLONE);
    expect(sent.map(call => [call.params, call.body])).toEqual([[{ id: PROJECT.id }, { url: URL }]]);
    expect(
      must(mounted.container.querySelector<HTMLInputElement>('[data-project-clone-url]'), 'the address').value,
    ).toBe('');
    await mounted.unmount();
  });

  it('sends nothing for an address git must not be handed, and quotes the daemon’s refusal, keeping the address', async () => {
    const calls: Call[] = [];
    const mounted = await open(
      page({ [CLONE]: refusal(422, 'cloned already exists in this project.', 'project_clone_failed') }, calls, () =>
        withRepos('app'),
      ),
    );
    await cloneNow(mounted, 'ext::sh -c x');
    expect(calls.filter(call => call.route === CLONE)).toEqual([]);
    expect(mounted.container.querySelector('[data-project-clone-submit]')?.hasAttribute('disabled')).toBe(true);
    await cloneNow(mounted, URL);
    await settleUntil(
      () => mounted.container.querySelector('[data-project-clone-refused]') !== null,
      'the refusal',
      interact,
    );
    expect(mounted.container.querySelector('[data-project-clone-refused]')?.textContent).toContain(
      'cloned already exists in this project.',
    );
    expect(
      must(mounted.container.querySelector<HTMLInputElement>('[data-project-clone-url]'), 'the address').value,
    ).toBe(URL);
    await mounted.unmount();
  });
});
