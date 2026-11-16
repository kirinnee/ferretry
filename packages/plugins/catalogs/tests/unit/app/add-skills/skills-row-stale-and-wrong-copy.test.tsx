/**
 * Two things a Skills row must get right, found in review of the `skills.row` contribution:
 * - the rows store outlives the Skills panel, so a list opened again must read again (an install or uninstall made
 *   while it was closed must show);
 * - one machine can hold several skills of one name (a runtime's and a project's), and a row's chip, Publish and
 *   Uninstall follow THAT row's copy, never another copy's.
 */
import { expect, test } from 'bun:test';
import { interact, mount, noteClientDaemon } from '@ferretry/app/testing';
import type { FunctionComponent } from 'react';
import { createSkillsRowPanel } from '../../../../app/views/skills-row.tsx';
import { installRecord } from '../support/catalog-views.ts';
import { byText, click, settle } from '../support/dom-form.ts';

/** A runtime-installed skill is read by the runtimes that layer it, and listed as Ferretry's own. */
const runtimeCopy = { path: '/fixtures/fleet/assets/skills/pdf-tools/SKILL.md', scope: 'ferretry', runtimes: ['box'] };
const projectCopy = (root: string, folder = '.claude') => ({
  path: `${root}/${folder}/skills/pdf-tools/SKILL.md`,
  scope: 'project',
  runtimes: ['box'],
});
const props = (over: Record<string, unknown> = {}) => ({
  ferret: 'f1',
  name: 'pdf-tools',
  invocation: '/pdf-tools',
  ...runtimeCopy,
  ...over,
});
const projectInstall = (root: string, harness: 'claude' | 'codex' = 'claude') => ({
  ...installRecord(),
  installId: `cin_${'j'.repeat(22)}` as const,
  target: { scope: 'project' as const, projectRoot: root, harness },
  destination: `${root}/.claude/skills/pdf-tools/`,
});
const q = (selector: string) => document.querySelector(selector);
const labels = () => [...document.querySelectorAll('[role="menuitem"]')].map(node => node.textContent);

const factory = (answers: { installs: ReturnType<typeof installRecord>[] }, daemon = 'alpha') => {
  const calls: { key: string; init: unknown }[] = [];
  const client = {
    call: async (key: string, init: unknown) => {
      calls.push({ key, init });
      if (key === 'GET /v1/catalog-installs') return { installs: answers.installs };
      if (key === 'GET /v1/catalogs') return { publisher: installRecord().provenance.publisher, catalogs: [] };
      if (key.startsWith('DELETE')) {
        const { installId } = (init as { params: { installId: string } }).params;
        const gone = answers.installs.find(install => install.installId === installId)!;
        answers.installs = answers.installs.filter(install => install !== gone);
        return { installId: gone.installId, provenance: gone.provenance, destination: gone.destination };
      }
      throw new Error(key);
    },
  } as never;
  noteClientDaemon(client, daemon);
  return {
    Panel: createSkillsRowPanel(client) as unknown as FunctionComponent<Record<string, unknown>>,
    calls,
  };
};

const menuOf = async (row: Element | null): Promise<(string | null)[]> => {
  await click(row?.querySelector('[data-row-more]') ?? null);
  await settle();
  return labels();
};

test('regression: a newly installed skill is recognised when reopening Skills on the same daemon', async () => {
  const answers = { installs: [] as ReturnType<typeof installRecord>[] };
  const { Panel, calls } = factory(answers);
  const first = await mount(<Panel {...props()} />);
  await settle();
  expect(q('[data-row-from]')).toBeNull();
  await first.unmount();
  // The person installs through Add skills / Sharing while Skills is closed. The plugin and client remain enabled.
  answers.installs = [installRecord()];
  const second = await mount(<Panel {...props()} />);
  await settle();
  const reads = calls.filter(call => call.key === 'GET /v1/catalog-installs').length;
  const labelled = q('[data-row-from]') !== null;
  await second.unmount();
  expect({ reads, labelled }).toEqual({ reads: 2, labelled: true });
});

test('regression: an uninstalled skill is not still offered an Uninstall when Skills is reopened', async () => {
  const answers = { installs: [installRecord()] };
  const { Panel } = factory(answers);
  const first = await mount(<Panel {...props()} />);
  await settle();
  expect(q('[data-row-from]')).not.toBeNull();
  await first.unmount();
  answers.installs = [];
  const second = await mount(<Panel {...props()} />);
  await settle();
  const labelled = q('[data-row-from]') !== null;
  const menu = await menuOf(document.body);
  await second.unmount();
  expect({ labelled, menu: menu.map(label => label?.startsWith('Publish')) }).toEqual({
    labelled: false,
    menu: [true],
  });
});

test('regression: a local project copy does not offer to uninstall a different runtime copy with the same name', async () => {
  const { Panel, calls } = factory({ installs: [installRecord()] });
  const view = await mount(<Panel {...props(projectCopy('/fixtures/unrelated-project'))} />);
  await settle();
  const labelled = q('[data-row-from]') !== null;
  await click(q('[data-row-more]'));
  await settle();
  const menu = labels();
  if (menu.includes('Uninstall')) {
    await click(byText(document, '[role="menuitem"]', 'Uninstall'));
    await click(q('[data-catalog-remove-yes]'));
    await settle();
  }
  const deleted = calls.filter(call => call.key.startsWith('DELETE'));
  await view.unmount();
  expect({ labelled, menu, deleted }).toEqual({
    labelled: false,
    menu: [expect.stringContaining('Publish')],
    deleted: [],
  });
});

test('a runtime copy and a project copy of one name each own only their own install', async () => {
  const runtime = installRecord();
  const project = projectInstall('/work/app');
  const { Panel, calls } = factory({ installs: [runtime, project] });
  const view = await mount(
    <>
      <div data-copy="runtime">
        <Panel {...props()} />
      </div>
      <div data-copy="project">
        <Panel {...props(projectCopy('/work/app'))} />
      </div>
      <div data-copy="other">
        <Panel {...props(projectCopy('/work/elsewhere'))} />
      </div>
    </>,
  );
  await settle();
  const chips = ['runtime', 'project', 'other'].map(
    copy => document.querySelector(`[data-copy="${copy}"] [data-row-from]`) !== null,
  );
  expect(chips).toEqual([true, true, false]);
  const runtimeMenu = await menuOf(q('[data-copy="runtime"]'));
  expect(runtimeMenu).toEqual([expect.stringContaining('Uninstall')]);
  // The runtime row names the runtime install; the project row names the project one.
  await click(byText(document, '[role="menuitem"]', runtimeMenu[0] ?? ''));
  expect(q('[data-copy="runtime"] [data-catalog-remove-confirm]')?.textContent).toContain(runtime.destination);
  await click(q('[data-copy="runtime"] [data-catalog-remove-no]'));
  const otherMenu = await menuOf(q('[data-copy="other"]'));
  expect(otherMenu).toEqual([expect.stringContaining('Publish')]);
  await view.unmount();
  expect(calls.filter(call => call.key.startsWith('DELETE'))).toEqual([]);
});

test('uninstalling from the project row deletes the project install, not the runtime one', async () => {
  const project = projectInstall('/work/app');
  const { Panel, calls } = factory({ installs: [installRecord(), project] });
  const view = await mount(<Panel {...props(projectCopy('/work/app'))} />);
  await settle();
  await click(q('[data-row-more]'));
  await click(byText(document, '[role="menuitem"]', labels()[0] ?? ''));
  await click(q('[data-catalog-remove-yes]'));
  await settle();
  const deleted = calls.filter(call => call.key.startsWith('DELETE'));
  await view.unmount();
  expect(deleted).toEqual([
    { key: 'DELETE /v1/catalog-installs/project/:installId', init: { params: { installId: project.installId } } },
  ]);
});

test('a Codex project install belongs to the .agents row of its root, and a root spelled with /./ or a slash matches', async () => {
  const codex = projectInstall('/work/app/./', 'codex');
  const { Panel } = factory({ installs: [codex] });
  const view = await mount(
    <>
      <div data-copy="agents">
        <Panel {...props(projectCopy('/work/app', '.agents'))} />
      </div>
      <div data-copy="claude">
        <Panel {...props(projectCopy('/work/app', '.claude'))} />
      </div>
    </>,
  );
  await settle();
  const chips = ['agents', 'claude'].map(
    copy => document.querySelector(`[data-copy="${copy}"] [data-row-from]`) !== null,
  );
  await view.unmount();
  expect(chips).toEqual([true, false]);
});

test("a skill in the harness home's own folder is nobody's install, and a runtime that does not read it is not its owner", async () => {
  const { Panel } = factory({ installs: [installRecord()] });
  const view = await mount(
    <>
      <div data-copy="user">
        <Panel {...props({ scope: 'user', path: '/home/k/.claude/skills/pdf-tools/SKILL.md' })} />
      </div>
      <div data-copy="elsewhere">
        <Panel {...props({ runtimes: ['other-runtime'] })} />
      </div>
    </>,
  );
  await settle();
  const chips = ['user', 'elsewhere'].map(
    copy => document.querySelector(`[data-copy="${copy}"] [data-row-from]`) !== null,
  );
  await view.unmount();
  expect(chips).toEqual([false, false]);
});

test('isolation: a late answer from alpha cannot replace beta rows after switching daemon-bound panel', async () => {
  let finishAlpha!: (value: unknown) => void;
  const alpha = {
    call: async (key: string) =>
      key === 'GET /v1/catalog-installs'
        ? await new Promise(resolve => {
            finishAlpha = resolve;
          })
        : { publisher: installRecord().provenance.publisher, catalogs: [] },
  } as never;
  noteClientDaemon(alpha, 'alpha');
  const Alpha = createSkillsRowPanel(alpha) as unknown as FunctionComponent<Record<string, unknown>>;
  const { Panel: Beta } = factory({ installs: [] }, 'beta');
  const view = await mount(<Alpha {...props()} />);
  await settle();
  await view.render(<Beta {...props()} />);
  await settle();
  await interact(async () => finishAlpha({ installs: [installRecord()] }));
  await settle();
  expect(q('[data-row-from]')).toBeNull();
  await view.unmount();
});

test('shared refresh: uninstalling a skill from one ferret updates another ferret row on the same daemon', async () => {
  const { Panel, calls } = factory({ installs: [installRecord()] });
  const view = await mount(
    <>
      <Panel {...props()} />
      <Panel {...props({ ferret: 'f2' })} />
    </>,
  );
  await settle();
  expect(document.querySelectorAll('[data-row-from]').length).toBe(2);
  await click(q('[data-row-more]'));
  await click(byText(document, '[role="menuitem"]', 'Uninstall'));
  expect(calls.filter(call => call.key.startsWith('DELETE'))).toHaveLength(0);
  await click(q('[data-catalog-remove-yes]'));
  await settle();
  expect(document.querySelectorAll('[data-row-from]').length).toBe(0);
  expect(calls.filter(call => call.key === 'GET /v1/catalog-installs')).toHaveLength(2);
  await view.unmount();
});
