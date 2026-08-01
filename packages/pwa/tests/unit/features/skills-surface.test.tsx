import { describe, expect, it } from 'bun:test';
import type { AvailableSkill } from '@ferretry/protocol';

import type { SkillsCatalogLoader } from '../../../src/features/skills/skills-api.ts';
import type { SkillsCatalog } from '../../../src/features/skills/skills-catalog.ts';
import { SkillsCatalogList, SkillsSurface } from '../../../src/features/skills/skills-surface.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { interact, mount, must } from '../../support/dom.ts';

const laptop = daemonConnection({
  daemonId: 'daemon/laptop',
  baseUrl: 'https://laptop.example.test',
  deviceToken: 'token-laptop',
});
const workstation = daemonConnection({
  daemonId: 'daemon/workstation',
  baseUrl: 'https://workstation.example.test',
  deviceToken: 'token-workstation',
});

const skill = (overrides: Partial<AvailableSkill> & Pick<AvailableSkill, 'name'>): AvailableSkill => ({
  description: 'Does a useful thing.',
  scope: 'global',
  origin: 'claude',
  ...overrides,
});

const claudeCatalog: SkillsCatalog = {
  harness: 'claude',
  skills: [
    skill({ name: 'kteam', description: 'Coordinate detached teammates.' }),
    skill({ name: 'run', description: 'Launch the project app.', scope: 'project', origin: 'both' }),
  ],
};

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

const buttons = (container: HTMLElement): HTMLButtonElement[] => [...container.querySelectorAll('button')];
const rowFor = (container: HTMLElement, invocation: string): HTMLButtonElement =>
  must(
    buttons(container).find(button => button.getAttribute('aria-label')?.startsWith(`Insert ${invocation} `)),
    `the ${invocation} row`,
  );
const refresh = (container: HTMLElement): HTMLButtonElement =>
  must(container.querySelector<HTMLButtonElement>('button[aria-label="Refresh skills"]'), 'the refresh button');
const search = (container: HTMLElement): HTMLInputElement =>
  must(container.querySelector<HTMLInputElement>('input[type="search"]'), 'the search field');

/**
 * React tracks the last value it wrote on the node itself, so assigning
 * `input.value` directly is invisible to it. Writing through the prototype
 * setter is what a real keystroke does and is what makes onChange fire.
 */
const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

const typeSearch = async (container: HTMLElement, value: string): Promise<void> => {
  const field = search(container);
  await interact(() => {
    nativeValueSetter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('SkillsCatalogList', () => {
  it('renders global before project as real lists, with the harness invocation on every row', async () => {
    const { container, unmount } = await mount(
      <SkillsCatalogList catalog={claudeCatalog} query="" onInsert={() => {}} />,
    );

    expect([...container.querySelectorAll('h3')].map(heading => heading.textContent)).toEqual(['Global', 'Project']);
    expect([...container.querySelectorAll('ul')].every(list => list.children.length > 0)).toBe(true);
    expect([...container.querySelectorAll('code')].map(code => code.textContent)).toEqual(['/kteam', '/run']);
    expect(rowFor(container, '/run').getAttribute('aria-label')).toBe(
      'Insert /run into composer draft. Launch the project app. Available for Claude and Codex.',
    );
    await unmount();
  });

  it('inserts the Codex form when the session runs Codex', async () => {
    const inserted: string[] = [];
    const { container, unmount } = await mount(
      <SkillsCatalogList
        catalog={{ harness: 'codex', skills: claudeCatalog.skills }}
        query=""
        onInsert={value => inserted.push(value)}
      />,
    );

    await interact(() => rowFor(container, '$kteam').click());
    expect(inserted).toEqual(['$kteam']);
    await unmount();
  });

  it('separates a filtered-out catalog from an installed-nothing one', async () => {
    const filtered = await mount(<SkillsCatalogList catalog={claudeCatalog} query="kubernetes" onInsert={() => {}} />);
    expect(filtered.container.textContent).toContain('No skills match “kubernetes”.');
    await filtered.unmount();

    const empty = await mount(
      <SkillsCatalogList catalog={{ harness: 'claude', skills: [] }} query="" onInsert={() => {}} />,
    );
    expect(empty.container.textContent).toContain('No skills are installed for this session.');
    await empty.unmount();
  });
});

describe('SkillsSurface', () => {
  const scope = daemonSessionScope(laptop, 'sess-1');

  it('loads, searches and inserts without submitting anything', async () => {
    const inserted: string[] = [];
    const loader: SkillsCatalogLoader = async () => claudeCatalog;
    const { container, unmount } = await mount(
      <SkillsSurface scope={scope} onInsert={value => inserted.push(value)} loadCatalog={loader} />,
    );

    expect(container.textContent).toContain('Claude · inserts /name');
    expect(container.textContent).toContain('2 skills');
    expect(search(container).disabled).toBe(false);

    await typeSearch(container, 'teammates');
    expect(container.textContent).toContain('1 of 2');
    expect(container.querySelectorAll('code')).toHaveLength(1);

    await interact(() => rowFor(container, '/kteam').click());
    expect(inserted).toEqual(['/kteam']);
    expect(must(container.querySelector('[aria-live="polite"]'), 'the live region').textContent).toBe(
      'Inserted /kteam into the composer draft. Review it before sending.',
    );
    await unmount();
  });

  it('shows a loading status with the search and refresh controls disabled', async () => {
    const gate = deferred<SkillsCatalog>();
    const { container, unmount } = await mount(
      <SkillsSurface scope={scope} onInsert={() => {}} loadCatalog={async () => await gate.promise} />,
    );

    expect(must(container.querySelector('[role="status"]'), 'the loading status').textContent).toBe('Loading skills…');
    expect(refresh(container).disabled).toBe(true);
    expect(search(container).disabled).toBe(true);

    await interact(async () => {
      gate.resolve({ harness: 'claude', skills: [] });
      await gate.promise;
    });
    expect(container.textContent).toContain('No skills are installed for this session.');
    // An empty catalog leaves nothing to search, so the field stays inert.
    expect(search(container).disabled).toBe(true);
    expect(container.textContent).toContain('0 skills');
    await unmount();
  });

  it('reports a failed read as an alert and retries on refresh', async () => {
    let attempt = 0;
    const loader: SkillsCatalogLoader = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('this token may not enumerate session skills');
      return { harness: 'claude', skills: [claudeCatalog.skills[0] as AvailableSkill] };
    };
    const { container, unmount } = await mount(
      <SkillsSurface scope={scope} onInsert={() => {}} loadCatalog={loader} />,
    );

    expect(must(container.querySelector('[role="alert"]'), 'the error').textContent).toContain(
      "Couldn't load skills: this token may not enumerate session skills",
    );

    await interact(() => refresh(container).click());
    expect(attempt).toBe(2);
    expect(container.textContent).toContain('1 skill');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await unmount();
  });

  it('stringifies a rejection that is not an Error', async () => {
    const { container, unmount } = await mount(
      <SkillsSurface
        scope={scope}
        onInsert={() => {}}
        loadCatalog={async () => {
          throw 'daemon closed the socket';
        }}
      />,
    );
    expect(must(container.querySelector('[role="alert"]'), 'the error').textContent).toContain(
      'daemon closed the socket',
    );
    await unmount();
  });

  it('refetches for the other daemon and never shows the first daemon’s catalog', async () => {
    const asked: DaemonSessionScope[] = [];
    const loader: SkillsCatalogLoader = async next => {
      asked.push(next);
      return next.daemonId === laptop.daemonId
        ? claudeCatalog
        : { harness: 'codex', skills: [skill({ name: 'deploy', description: 'Ship the workstation build.' })] };
    };

    const { container, render, unmount } = await mount(
      <SkillsSurface scope={scope} onInsert={() => {}} loadCatalog={loader} />,
    );
    await typeSearch(container, 'teammates');
    expect(container.textContent).toContain('/kteam');

    await render(
      <SkillsSurface scope={daemonSessionScope(workstation, 'sess-1')} onInsert={() => {}} loadCatalog={loader} />,
    );

    expect(asked.map(item => item.daemonId)).toEqual([laptop.daemonId, workstation.daemonId]);
    expect(container.textContent).not.toContain('/kteam');
    expect(container.textContent).toContain('$deploy');
    // The search resets with the catalog: a query typed against one daemon is
    // not a filter over another daemon's skills.
    expect(search(container).value).toBe('');
    await unmount();
  });

  it('aborts an in-flight read on unmount and never sets state afterwards', async () => {
    const gate = deferred<SkillsCatalog>();
    let signal: AbortSignal | undefined;
    const { unmount } = await mount(
      <SkillsSurface
        scope={scope}
        onInsert={() => {}}
        loadCatalog={async (_next, next) => {
          signal = next;
          return await gate.promise;
        }}
      />,
    );

    await unmount();
    expect(signal?.aborted).toBe(true);
    await interact(async () => {
      gate.resolve(claudeCatalog);
      await gate.promise;
    });
  });

  it('swallows a rejection that lands after the read was aborted', async () => {
    const gate = deferred<SkillsCatalog>();
    const { unmount } = await mount(
      <SkillsSurface scope={scope} onInsert={() => {}} loadCatalog={async () => await gate.promise} />,
    );

    await unmount();
    await interact(async () => {
      gate.reject(new Error('aborted'));
      await gate.promise.catch(() => {});
    });
  });
});
