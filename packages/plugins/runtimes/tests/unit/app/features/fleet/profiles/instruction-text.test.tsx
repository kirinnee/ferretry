/**
 * Rehearsal 3, F2: a profile's page shows the words of the instructions it holds, read only (v4's component form showed
 * them as `body`). The text comes from the catalogue the page already reads; nothing here writes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  InstructionTexts,
  profileInstructions,
} from '../../../../../../app/features/fleet/profiles/instruction-text.tsx';
import { ProfilesTab } from '../../../../../../app/features/fleet/profiles/profiles-tab.tsx';
import type { Mounted } from '../../../../support/dom.ts';
import {
  componentCatalog,
  instructions,
  profile,
  profileCatalog,
  studioCatalog,
} from '../components/catalog-fixture.ts';
import { click, mountSettled, scriptedMachine, TAB_PATH, tabProps, text } from '../components/view-support.tsx';

let mounted: Mounted | undefined;
beforeEach(() => window.history.replaceState(null, '', TAB_PATH));
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  window.history.replaceState(null, '', '/');
});

const open = async (profileName: string) => {
  mounted = await mountSettled(<ProfilesTab {...tabProps(scriptedMachine())} />);
  await click(mounted.container, `[data-profile-row="${profileName}"]`);
  return mounted.container;
};

describe('a profile’s instructions text', () => {
  it('shows the text of an instructions item the profile holds', async () => {
    const root = await open('Default');
    const section = root.querySelector('[data-catalog-section="instruction-text"]');
    expect(section).not.toBeNull();
    expect(section?.querySelector('summary')?.textContent).toBe('Main instructions');
    expect(text(root, '[data-instruction-text="instructions/Main instructions"]')).toBe('# How we work\n- Small PRs.');
  });

  it('reads the text through a base profile, once', async () => {
    const root = await open('Agent work');
    const items = [...root.querySelectorAll('[data-instruction-item]')].map(item =>
      item.getAttribute('data-instruction-item'),
    );
    expect(items).toEqual(['instructions/Main instructions']);
  });

  it('is read only: no field, no save, nothing to type into', async () => {
    const root = await open('Default');
    const section = root.querySelector('[data-catalog-section="instruction-text"]');
    expect(section?.querySelector('textarea, input, button')).toBeNull();
  });

  it('says so when a secret-looking value was cut out of the text', async () => {
    const cut = { ...instructions, content: { form: 'text' as const, text: 'token ‹hidden›', redacted: true } };
    const components = componentCatalog();
    const withCut = {
      ...components,
      kinds: components.kinds.map(group => (group.kind === 'instructions' ? { ...group, components: [cut] } : group)),
    };
    mounted = await mountSettled(
      <ProfilesTab {...tabProps(scriptedMachine({ catalog: studioCatalog({ components: withCut }) }))} />,
    );
    await click(mounted.container, '[data-profile-row="Default"]');
    const section = text(mounted.container, '[data-catalog-section="instruction-text"]');
    expect(section).toContain('replaced by ‹hidden›');
    expect(section).toContain('token ‹hidden›');
  });

  it('says it could not be read, rather than showing nothing, when the daemon sent no text', () => {
    const unread = { ...instructions, content: undefined };
    const markup = renderToStaticMarkup(
      <InstructionTexts
        profile={profile('P', ['instructions/Main instructions'])}
        profiles={[]}
        components={[unread]}
      />,
    );
    expect(markup).toContain('could not be read');
  });

  it('names no section for a profile without instructions', async () => {
    const catalog = studioCatalog({ profiles: profileCatalog([profile('Bare', ['mcp/github'])]) });
    mounted = await mountSettled(<ProfilesTab {...tabProps(scriptedMachine({ catalog }))} />);
    await click(mounted.container, '[data-profile-row="Bare"]');
    expect(mounted.container.querySelector('[data-catalog-section="instruction-text"]')).toBeNull();
  });

  it('follows a base profile once, however many layers reach the same instructions', () => {
    const base = profile('Base', ['instructions/Main instructions']);
    const top = profile('Top', ['profile/Base', 'instructions/Main instructions', 'profile/Base']);
    expect(profileInstructions(top, [base, top], [instructions]).map(held => held.reference)).toEqual([
      'instructions/Main instructions',
    ]);
  });
});
