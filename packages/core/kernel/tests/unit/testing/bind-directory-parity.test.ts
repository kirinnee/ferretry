/**
 * `kernel.paths.bindDirectory` on the testing host answers every case as the real host does: capture, the state-home
 * fence's answer, and a re-verify that holds a folder which was moved, re-pointed or replaced after the check. The real
 * host is booted for real (its folders on the disk); each case is spelled with that host's own means (`rename`/`ln -s`
 * on one, `setDirectory`/`replaceDirectory` on the other). A plugin that did not declare `permissions.checkDirectory`
 * binds nothing on either.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { KernelPorts } from '../../../contract/ports.ts';
import { bootHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

interface Seen {
  ferrets?: KernelPorts;
  stranger?: KernelPorts;
}

const halves = (seen: Seen) => [
  implementDaemon(
    definePlugin({
      id: 'ferrets',
      title: 'Ferrets',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { checkDirectory: true },
    }),
    {
      build: ({ kernel }) => {
        seen.ferrets = kernel;
        return {};
      },
    },
  ),
  implementDaemon(
    definePlugin({ id: 'stranger', title: 'Stranger', version: '5.0.0', api: 5, core: false, kinds: [] }),
    {
      build: ({ kernel }) => {
        seen.stranger = kernel;
        return {};
      },
    },
  ),
];

type Answer =
  | { readonly bound: { readonly inside: boolean } }
  | { readonly refused: string }
  | { readonly threw: true };

/** What each host does to the project folder between the check and the use. */
interface Places {
  readonly project: string;
  readonly state: string;
  readonly otherwise: string;
  readonly repoint: (to: string) => Promise<void>;
  readonly replace: () => Promise<void>;
  /** Back to the first folder. */
  readonly restore: () => Promise<void>;
}

async function cases(seen: Seen, places: Places): Promise<readonly (readonly [string, Answer])[]> {
  const paths = (seen.ferrets as KernelPorts).paths;
  const rows: (readonly [string, Answer])[] = [];
  const bind = async (path: string) => await paths.bindDirectory(path);
  const verdict = async (
    title: string,
    folder: Awaited<ReturnType<typeof bind>>,
    after: () => Promise<void> = async () => {},
  ): Promise<void> => {
    if (!folder.ok) {
      rows.push([title, { refused: folder.error.reason }]);
      return;
    }
    await after();
    const again = await folder.value.verify();
    rows.push([
      title,
      again.ok ? { bound: { inside: folder.value.insideStateHome } } : { refused: again.error.reason },
    ]);
  };
  await verdict('a project folder, unchanged', await bind(places.project));
  await verdict('a project folder swapped for a link elsewhere after the check', await bind(places.project), () =>
    places.repoint(places.otherwise),
  );
  await places.restore();
  await verdict(
    'a project folder swapped for a link into the state home after the check',
    await bind(places.project),
    () => places.repoint(places.state),
  );
  await places.restore();
  await verdict('a project folder replaced by another directory after the check', await bind(places.project), () =>
    places.replace(),
  );
  await places.restore();
  await verdict('a folder inside the state home', await bind(places.state));
  rows.push([
    'the fence answer of the state home',
    await (async (): Promise<Answer> => {
      const result = await bind(places.state);
      return result.ok ? { bound: { inside: result.value.insideStateHome } } : { refused: result.error.reason };
    })(),
  ]);
  await verdict('a relative path', await bind('project'));
  await verdict('a folder that is not there', await bind(`${places.project}-missing`));
  rows.push([
    'a plugin that did not declare checkDirectory',
    await (async (): Promise<Answer> => {
      try {
        await (seen.stranger as KernelPorts).paths.bindDirectory(places.project);
        return { bound: { inside: false } };
      } catch {
        return { threw: true };
      }
    })(),
  ]);
  return rows;
}

async function onTestingHost() {
  const seen: Seen = {};
  const home = '/home/owner/.test-home';
  const places = {
    project: '/work/project',
    state: `${home}/state`,
    otherwise: '/work/other',
  };
  const host = await testHost({
    plugins: halves(seen),
    fenceHome: home,
    directories: {
      [places.project]: places.project,
      [places.otherwise]: places.otherwise,
      [places.state]: places.state,
      [`${places.project}-aside`]: `${places.project}-aside`,
    },
  });
  try {
    return await cases(seen, {
      ...places,
      repoint: async to => host.setDirectory(places.project, to),
      replace: async () => host.replaceDirectory(places.project),
      restore: async () => host.setDirectory(places.project, places.project),
    });
  } finally {
    await host.stop();
  }
}

async function onRealHost() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/bind-directory-parity-`));
  parents.push(parent);
  const home = `${parent}/owner/.test-home`;
  const project = `${parent}/work/project`;
  const otherwise = `${parent}/work/other`;
  await mkdir(project, { recursive: true });
  await mkdir(otherwise, { recursive: true });
  const seen: Seen = {};
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: halves(seen),
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  const aside = `${project}-aside`;
  const put = async (): Promise<void> => {
    await rm(project, { recursive: true, force: true });
  };
  try {
    return await cases(seen, {
      project,
      state: `${home}/state`,
      otherwise,
      repoint: async to => {
        await rename(project, aside);
        await symlink(to, project);
      },
      replace: async () => {
        await rename(project, aside);
        await mkdir(project);
      },
      restore: async () => {
        await put();
        await rename(aside, project).catch(async () => await mkdir(project));
      },
    });
  } finally {
    await outcome.host.stop();
  }
}

test('bindDirectory parity: the testing host answers every case as the real host does', async () => {
  const testing = await onTestingHost();
  const real = await onRealHost();
  expect(testing.map(([title]) => title)).toEqual(real.map(([title]) => title));
  expect(Object.fromEntries(testing)).toEqual(Object.fromEntries(real));
  const byCase = Object.fromEntries(real);
  expect(byCase['a project folder, unchanged']).toEqual({ bound: { inside: false } });
  expect(byCase['a project folder swapped for a link elsewhere after the check']).toEqual({ refused: 'changed' });
  expect(byCase['a project folder swapped for a link into the state home after the check']).toEqual({
    refused: 'changed',
  });
  expect(byCase['a project folder replaced by another directory after the check']).toEqual({ refused: 'changed' });
  expect(byCase['a folder inside the state home']).toEqual({ bound: { inside: true } });
  expect(byCase['the fence answer of the state home']).toEqual({ bound: { inside: true } });
  expect(byCase['a relative path']).toEqual({ refused: 'not_absolute' });
  expect(byCase['a folder that is not there']).toEqual({ refused: 'not_a_directory' });
  expect(byCase['a plugin that did not declare checkDirectory']).toEqual({ threw: true });
});
