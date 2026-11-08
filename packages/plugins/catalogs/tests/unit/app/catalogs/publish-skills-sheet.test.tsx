import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SkillEntry } from '../../../../app/lib/machine-skills.ts';
import { PublishSkillsSheet } from '../../../../app/features/catalogs/publish-skills-sheet.tsx';
import type { MachineSkillEntriesLoader } from '../../../../app/lib/machine-skills.ts';
import { daemonConnection } from '../../../../app/lib/machine.ts';
import { fakeClient } from '../support/catalog-client.ts';
import { CATALOG, DIGEST, ITEM, itemPreview, ownedCatalog } from '../support/catalog-views.ts';
import { click, settle, typeInto } from '../support/dom-form.ts';
import { mount } from '@ferretry/app/testing';

beforeEach(() => {
  document.body.replaceChildren();
});
afterEach(() => {
  mock.restore();
});

const connection = daemonConnection({ daemonId: 'alpha' });
const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const text = (): string => document.body.textContent ?? '';

const skill = (name: string, path = `/home/k/.claude/skills/${name}/SKILL.md`): SkillEntry => ({
  name,
  description: `What ${name} does`,
  harness: 'claude',
  scope: 'user',
  path,
  runtimes: ['claude-work'],
});
const ENTRIES = [skill('pdf-tools'), skill('lint-fix')];

async function show(load: MachineSkillEntriesLoader | undefined, handlers: Parameters<typeof fakeClient>[0] = {}) {
  const fake = fakeClient({ 'GET /v1/catalogs': () => ({ catalogs: [ownedCatalog()] }), ...handlers });
  const closed: string[] = [];
  const changed: string[] = [];
  const view = await mount(
    <PublishSkillsSheet
      connection={connection}
      catalog={ownedCatalog()}
      createClient={fake.factory}
      onClose={() => closed.push('closed')}
      onChanged={() => changed.push('changed')}
      {...(load === undefined ? {} : { load })}
    />,
  );
  await settle();
  return { fake, view, closed, changed };
}

describe('PublishSkillsSheet', () => {
  it('lists the machine’s skills, says which this catalog holds, and offers Publish on the rest', async () => {
    const { view } = await show(async () => ENTRIES);
    expect(q('[data-catalog-sheet="publish-skills"]')?.textContent).toContain('Publish skills in Team skills');
    expect(text()).toContain('Your own copy keeps working as it is.');
    expect(q('[data-publish-skill="pdf-tools"] [data-publish-held]')?.textContent).toBe('In this catalog · v2');
    expect(q('[data-publish-skill="pdf-tools"] [data-publish-pick]')).toBeNull();
    expect(q('[data-publish-pick="lint-fix"]')?.getAttribute('aria-label')).toBe('Publish lint-fix in Team skills');
    expect(q('[data-publish-skill="lint-fix"] [data-publish-where]')?.textContent).toBe('account claude-work');
    await view.unmount();
  });

  it('searches, and says when nothing matches or the machine has no skills', async () => {
    const { view } = await show(async () => ENTRIES);
    await typeInto(q('[data-publish-search]'), 'lint');
    expect(
      [...document.querySelectorAll('[data-publish-skill]')].map(row => row.getAttribute('data-publish-skill')),
    ).toEqual(['lint-fix']);
    await typeInto(q('[data-publish-search]'), 'nothing like it');
    expect(q('[data-publish-empty]')?.textContent).toBe('No skill matches “nothing like it”.');
    await view.unmount();
    const empty = await show(async () => []);
    expect(q('[data-publish-empty]')?.textContent).toBe('There are no skills on this machine yet.');
    await empty.view.unmount();
  });

  it('says it is reading, then says why when the machine cannot be read', async () => {
    let fail: (reason: unknown) => void = () => undefined;
    const { view } = await show(() => new Promise((_resolve, reject) => (fail = reject)));
    expect(text()).toContain('Reading this machine’s skills…');
    fail(new Error('the daemon said no'));
    await settle();
    expect(q('[data-catalog-failure]')?.textContent).toContain(
      'This machine’s skills could not be read. the daemon said no',
    );
    await view.unmount();
    const bare = await show(async () => {
      throw 'no reason';
    });
    expect(q('[data-catalog-failure]')?.textContent).toContain('This machine’s skills could not be read.');
    await bare.view.unmount();
  });

  it('ignores an answer that arrives after it closed', async () => {
    let answer: (entries: readonly SkillEntry[]) => void = () => undefined;
    let fail: (reason: unknown) => void = () => undefined;
    const late = await show(() => new Promise(resolve => (answer = resolve)));
    await late.view.unmount();
    answer(ENTRIES);
    const failing = await show(() => new Promise((_resolve, reject) => (fail = reject)));
    await failing.view.unmount();
    fail(new Error('too late'));
    await settle();
    expect(q('[data-catalog-failure]')).toBeNull();
  });

  it('Publish opens the add sheet aimed at this catalog, steps aside while it is open, and reads again when it lands', async () => {
    const { view, changed } = await show(async () => ENTRIES, {
      [`POST /v1/catalogs/${CATALOG}/items/preview`]: () => itemPreview({ name: 'lint-fix' }),
      [`POST /v1/catalogs/${CATALOG}/items`]: () => ({
        itemId: ITEM,
        kind: 'skill',
        name: 'lint-fix',
        itemVersion: 1,
        digest: DIGEST,
      }),
    });
    await click(q('[data-publish-pick="lint-fix"]'));
    await settle();
    expect(q('[data-catalog-sheet="publish-skills"]')).toBeNull();
    expect(q('[data-catalog-sheet="add"]')).not.toBeNull();
    await click(q('[data-catalog-preview]'));
    await settle();
    await click(q('[data-catalog-add]'));
    await settle();
    expect(changed).toEqual(['changed']);
    await click(q('[data-catalog-done]'));
    await settle();
    expect(q('[data-catalog-sheet="publish-skills"]')).not.toBeNull();
    await view.unmount();
  });

  it('closes on its own close button', async () => {
    const { view, closed } = await show(async () => ENTRIES);
    await click(q('button[aria-label="Close Publish skills"]'));
    expect(closed).toEqual(['closed']);
    await view.unmount();
  });

  it('says why nothing is listed when Skills has offered no list', async () => {
    const { view } = await show(undefined);
    expect(document.body.textContent).toContain('Skills has not offered its list to Catalogs yet.');
    expect(q('[data-publish-skill]')).toBeNull();
    await view.unmount();
  });
});
