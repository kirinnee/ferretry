import { afterEach, describe, expect, it } from 'bun:test';
import { SessionSkillsSurface } from '../../../src/features/skills/session-skills-surface.tsx';
import type { SkillsCatalog } from '../../../src/features/skills/skills-catalog.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { registerComposerQuoteTarget } from '../../../src/lib/quote.ts';
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
const scope = daemonSessionScope(laptop, 'session-a');

const claudeCatalog: SkillsCatalog = {
  harness: 'claude',
  skills: [
    { name: 'floop', description: 'Review until every reviewer is satisfied.', scope: 'global', origin: 'both' },
  ],
};
const codexCatalog: SkillsCatalog = { ...claudeCatalog, harness: 'codex' };

const composers: Array<() => void> = [];
const originalFetch = globalThis.fetch;

const composerAt = (target: DaemonSessionScope, draft = ''): { draft: string } => {
  const state = { draft };
  composers.push(
    registerComposerQuoteTarget({
      ...target,
      draft: () => state.draft,
      replaceDraft: next => {
        state.draft = next;
      },
    }),
  );
  return state;
};

const useAction = (container: HTMLElement, invocation: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll('button')].find(
      button => button.getAttribute('aria-label') === `Use ${invocation} in chat`,
    ),
    `the ${invocation} use action`,
  );

const announcement = (container: HTMLElement): string =>
  must(container.querySelector('[aria-live="polite"]'), 'the live region').textContent ?? '';

afterEach(() => {
  globalThis.fetch = originalFetch;
  while (composers.length > 0) composers.pop()?.();
});

describe('SessionSkillsSurface', () => {
  it('inserts Claude syntax into the composer of exactly this daemon session', async () => {
    const mine = composerAt(scope, 'please');
    // Same session id on a different daemon. Two paired daemons routinely carry
    // the same session id over unrelated skill directories, so this is the
    // delivery that must never happen.
    const stranger = composerAt(daemonSessionScope(workstation, 'session-a'));
    const { container, unmount } = await mount(
      <SessionSkillsSurface connection={laptop} loadCatalog={async () => claudeCatalog} scope={scope} />,
    );

    await interact(() => useAction(container, '/floop').click());

    expect(mine.draft).toBe('please /floop ');
    expect(stranger.draft).toBe('');
    expect(announcement(container)).toBe('Inserted /floop into the composer draft. Review it before sending.');
    await unmount();
  });

  it('inserts Codex syntax on a Codex session rather than a canonicalised alias', async () => {
    const mine = composerAt(scope);
    const { container, unmount } = await mount(
      <SessionSkillsSurface connection={laptop} loadCatalog={async () => codexCatalog} scope={scope} />,
    );

    await interact(() => useAction(container, '$floop').click());

    // `$floop` is what Codex invokes. Rewriting it to the canonical `/floop`
    // would type a command that harness does not have.
    expect(mine.draft).toBe('$floop ');
    await unmount();
  });

  it('says the two authored aliases are one reference instead of repeating it', async () => {
    const mine = composerAt(scope, '/floop ');
    const { container, unmount } = await mount(
      <SessionSkillsSurface connection={laptop} loadCatalog={async () => codexCatalog} scope={scope} />,
    );

    await interact(() => useAction(container, '$floop').click());

    expect(mine.draft).toBe('/floop ');
    expect(announcement(container)).toBe('$floop is already in this message.');
    await unmount();
  });

  it('reports an absent composer instead of silently dropping the invocation', async () => {
    const { container, unmount } = await mount(
      <SessionSkillsSurface connection={laptop} loadCatalog={async () => claudeCatalog} scope={scope} />,
    );

    await interact(() => useAction(container, '/floop').click());

    expect(announcement(container)).toBe('No message box is open for this session, so there is nowhere to add it.');
    await unmount();
  });

  it('reads the catalog from its own daemon when no loader is supplied', async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return Response.json(claudeCatalog);
    }) as typeof fetch;
    const mine = composerAt(scope);
    const { container, unmount } = await mount(<SessionSkillsSurface connection={laptop} scope={scope} />);

    await interact(() => useAction(container, '/floop').click());

    expect(asked).toEqual(['https://laptop.example.test/v1/sessions/session-a/skills']);
    expect(mine.draft).toBe('/floop ');
    await unmount();
  });
});
