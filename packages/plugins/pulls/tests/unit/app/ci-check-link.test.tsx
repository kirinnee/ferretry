import { describe, expect, test } from 'bun:test';
import { ScreenHrefProvider } from '@ferretry/app';
import { interact, mount, must, RouterProvider, settleUntil } from '@ferretry/app/testing';
import { StandInAdmission, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import { CiTab } from '../../../app/features/ci-run/ci-runs-list.tsx';
import type { CiClient } from '../../../app/features/ci-run/ci-api.ts';
import daemon from '../../../daemon/index.ts';
import { FAKE_ACCOUNT, FakeGithub } from '../../fixtures/fake-github/index.ts';
import { T0, ghCheck, ghJob, ghRun, seedCi } from '../../fixtures/fake-github/ci.ts';

/**
 * A check from another CI, end to end through the REAL daemon reader (the fake is GitHub, not the check result): what the
 * CI tab links it to must be somewhere the daemon can actually answer, or its own page on GitHub.
 */
const PROJECT = '11111111-1111-4111-8111-111111111111';
const SCOPE = { project: PROJECT, repo: { owner: 'octo', name: 'hello' } };

const info = (): ProjectInfo =>
  ({
    id: PROJECT,
    name: 'hello',
    path: '/work/hello',
    source: 'existing-folder',
    createdAt: '2026-01-01T00:00:00.000Z',
    accounts: [FAKE_ACCOUNT],
    repos: [{ path: '.', remote: 'https://github.com/octo/hello.git', provider: 'github' }],
  }) as ProjectInfo;

async function seeded() {
  const github = new FakeGithub();
  seedCi(github, {
    pr: 7,
    runs: [ghRun({ id: 900 })],
    jobs: { 900: [ghJob({ id: 1, name: 'build', start: 10, end: 70 })] },
    checks: [
      ghCheck({ id: 900, name: 'ci/on-github', url: 'https://github.com/octo/hello/runs/900', start: 15, end: 80 }),
      ghCheck({ id: 901, name: 'ci/elsewhere', start: 15, end: 80 }),
      ghCheck({ id: 902, name: 'ci/insecure', url: 'http://github.com/octo/hello/runs/902', start: 15, end: 80 }),
    ],
  });
  const host = await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => ownerStanding()),
    clock: fixedClock(new Date(T0 + 300_000).toISOString()),
    fakes: {
      gitAccounts: {
        ...github.accounts,
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        recordKeys: async () => undefined,
      },
      projects: { list: async () => [info()], find: async (id: string) => (id === PROJECT ? info() : undefined) },
    },
  });
  return host;
}

/** The app's client, answering from the real daemon routes. */
const clientOver = (host: Awaited<ReturnType<typeof seeded>>): CiClient => ({
  call: async <Answer,>(
    route: string,
    init?: { params?: Readonly<Record<string, string>>; query?: Readonly<Record<string, string>> },
  ): Promise<Answer> => {
    const [method, template] = route.split(' ') as [string, string];
    const path = template.replace(/:(\w+)/gu, (_, key: string) => init?.params?.[key] ?? '');
    const answer = await host.request(method as 'GET', path, { query: { ...init?.query }, as: owner() });
    if (answer.status !== 200) throw new Error(`the daemon answered ${answer.status}`);
    return answer.json<Answer>();
  },
});

describe('a check from another CI in the CI tab', () => {
  test('links to its own https github.com page, never to the Actions run screen; others are plain rows', async () => {
    const host = await seeded();
    const hrefOf = (_daemon: string, plugin: string, screen: string, params: Readonly<Record<string, string>> = {}) =>
      `/d/${plugin}/${screen}/${params.runId ?? ''}`;
    const mounted = await mount(
      <RouterProvider>
        <ScreenHrefProvider href={hrefOf}>
          <CiTab client={clientOver(host)} daemon="d" scope={SCOPE} target={{ pr: 7 }} nowMs={T0 + 300_000} />
        </ScreenHrefProvider>
      </RouterProvider>,
    );
    await settleUntil(() => mounted.container.querySelector('[data-ci-tab]') !== null, 'the tab', interact);
    const row = (name: string): HTMLElement =>
      must(
        [...mounted.container.querySelectorAll<HTMLElement>('[data-ci-run]')].find(el =>
          (el.textContent ?? '').includes(name),
        ),
        name,
      );
    // An Actions run keeps the run screen, by ITS id.
    const actions = must(row('CI').querySelector('a'), 'the Actions run link');
    expect(actions.getAttribute('href')).toBe('/d/pulls/ci-run/900');
    // The check that shares that id does NOT: it would open the Actions run above.
    const onGithub = must(row('ci/on-github').querySelector('a'), 'the check link');
    expect(onGithub.getAttribute('href')).toBe('https://github.com/octo/hello/runs/900');
    expect(onGithub.getAttribute('rel')).toContain('noopener');
    expect(row('ci/on-github').getAttribute('data-ci-check')).toBe('true');
    // Any other address is shown, not linked.
    expect(row('ci/elsewhere').querySelector('a')).toBeNull();
    expect(row('ci/insecure').querySelector('a')).toBeNull();
    expect(row('ci/elsewhere').textContent).toContain('ci/elsewhere');
    expect(mounted.container.querySelectorAll('a[href^="/d/pulls/ci-run/"]').length).toBe(1);
  });

  test('the daemon has no run for a check id: asking for it is a refusal, which is why no link goes there', async () => {
    const host = await seeded();
    const answer = await host.request('GET', `/v1/pulls/${PROJECT}/octo~hello/runs/901`, { as: owner() });
    expect(answer.status).toBe(404);
  });
});
