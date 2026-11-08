/** catalogs#5 — the install sheets offer the machine's registered projects, read from Projects' own list. */
import { describe, expect, it } from 'bun:test';
import { deviceViewHarness, fakeReachRow, mount } from '@ferretry/app/testing';
import { useState } from 'react';
import { useInstallHost } from '../../../app/views/catalogs-views.tsx';
import { readRegisteredProjects, useRegisteredProjects } from '../../../app/lib/registered-projects.ts';

const ROW = {
  id: '6f8d5c1e-0b0a-4c55-9d6e-2f1a3b4c5d6e',
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'existing-folder',
  createdAt: '2026-10-16T10:00:00.000Z',
};
const clientOf = (answer: () => unknown) => ({
  call: (async (route: string) => {
    expect(route).toBe('GET /v1/projects');
    return answer();
  }) as never,
});

function Probe({ client }: { readonly client: ReturnType<typeof clientOf> }) {
  const projects = useRegisteredProjects(client);
  return <p data-probe="">{projects.map(project => `${project.name}@${project.path}`).join(',') || 'none'}</p>;
}

function HostProbe({ client }: { readonly client: ReturnType<typeof clientOf> }) {
  const host = useInstallHost({} as never, 'd1', client);
  return <p data-host="">{host.projects?.map(project => project.name).join(',') ?? 'unset'}</p>;
}

const projectsClient = (name: string) => clientOf(() => [{ ...ROW, name, path: `/work/${name}` }]);

function TargetProbe({ target, client }: { readonly target: string; readonly client: ReturnType<typeof clientOf> }) {
  const host = useInstallHost({} as never, 'd1', client);
  const [shown, setShown] = useState('unread');
  const [asked, setAsked] = useState('');
  if (asked !== target) {
    setAsked(target);
    host.readProjects?.({ daemonId: target } as never).then(
      list => setShown(list.map(project => project.name).join(',')),
      (reason: unknown) => setShown(`refused: ${reason instanceof Error ? reason.message : String(reason)}`),
    );
  }
  return <p data-target="">{shown}</p>;
}

describe('catalogs#5 registered projects for the install sheet', () => {
  it('reads the projects of the machine installed ONTO through that machine’s own client (two machines)', async () => {
    const harness = deviceViewHarness({ plugin: 'catalogs', fragments: [] });
    harness.setRows([
      fakeReachRow({ daemon: 'd1', client: projectsClient('on-d1') as never }),
      fakeReachRow({ daemon: 'd2', client: projectsClient('on-d2') as never }),
    ]);
    const other = await mount(
      <harness.Harness place="daemon">
        <TargetProbe target="d2" client={projectsClient('on-d1')} />
      </harness.Harness>,
    );
    const own = await mount(
      <harness.Harness place="daemon">
        <TargetProbe target="d1" client={projectsClient('on-d1')} />
      </harness.Harness>,
    );
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(other.container.textContent).toBe('on-d2');
      expect(own.container.textContent).toBe('on-d1');
    } finally {
      await other.unmount();
      await own.unmount();
    }
  });

  it('refuses in the shell’s own words for a machine where Catalogs is off', async () => {
    const harness = deviceViewHarness({ plugin: 'catalogs', fragments: [] });
    harness.setNoReach({ d9: { waiting: false, line: 'Catalogs is off on this machine.' } });
    const view = await mount(
      <harness.Harness place="daemon">
        <TargetProbe target="d9" client={projectsClient('on-d1')} />
      </harness.Harness>,
    );
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(view.container.textContent).toContain('refused: Catalogs is off on this machine.');
    } finally {
      await view.unmount();
    }
  });

  it('reduces Projects’ list to a name and a folder', async () => {
    expect(await readRegisteredProjects(clientOf(() => [ROW]))).toEqual([{ name: 'ferretry', path: '/work/ferretry' }]);
  });

  it('offers the registered projects once read', async () => {
    const view = await mount(<Probe client={clientOf(() => [ROW])} />);
    try {
      expect(view.container.textContent).toBe('ferretry@/work/ferretry');
    } finally {
      await view.unmount();
    }
  });

  it('puts them on the install host the sharing and add-skills screens hand the sheets', async () => {
    const view = await mount(<HostProbe client={clientOf(() => [ROW])} />);
    try {
      expect(view.container.textContent).toBe('ferretry');
    } finally {
      await view.unmount();
    }
  });

  it('offers none when the list cannot be read', async () => {
    const view = await mount(
      <Probe
        client={clientOf(() => {
          throw new Error('down');
        })}
      />,
    );
    try {
      expect(view.container.textContent).toBe('none');
    } finally {
      await view.unmount();
    }
  });

  it('ignores an answer that lands after the sheet closed', async () => {
    let release: (value: unknown) => void = () => undefined;
    const late = new Promise(resolve => {
      release = resolve;
    });
    const view = await mount(<Probe client={clientOf(() => late)} />);
    await view.unmount();
    release([ROW]);
    await late;
    const failing = new Promise((_resolve, reject) => reject(new Error('late')));
    const second = await mount(<Probe client={clientOf(() => failing)} />);
    await second.unmount();
    await failing.catch(() => undefined);
    expect(true).toBe(true);
  });
});
