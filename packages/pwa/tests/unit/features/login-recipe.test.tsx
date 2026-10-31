import { afterEach, describe, expect, it } from 'bun:test';
import type { LoginEntryList, PutLoginEntryRequest } from '@ferretry/protocol';
import { LoginsCard } from '../../../src/features/secrets/logins-card.tsx';
import { LoginsSurface } from '../../../src/features/secrets/logins-surface.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';
import { byText, click, settle } from '../../support/dom-form.ts';
import { fakeClient, login, logins } from '../../support/input-fixtures.ts';
import {
  BASE_RECIPE,
  NEXT_RECIPE,
  PROPOSAL_ID,
  recipeLogins,
  withRecipe,
} from '../../support/login-recipe-fixtures.ts';

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const typeIntoTextarea = async (element: Element | null, value: string): Promise<void> => {
  const area = must(element, 'a textarea') as HTMLTextAreaElement;
  await interact(() => {
    const setter = must(Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set, 'a setter');
    setter.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const show = async (list: LoginEntryList, error: string | null = null, accept = true) => {
  const puts: { id: string; body: PutLoginEntryRequest }[] = [];
  const decisions: { id: string; proposalId: string; decision: string }[] = [];
  const view = await mount(
    <LoginsCard
      list={list}
      error={error}
      onPut={async (id, body) => {
        puts.push({ id, body });
        return accept;
      }}
      onRename={async () => true}
      onRemove={async () => true}
      onDecide={async (id, proposalId, decision) => {
        decisions.push({ id, proposalId, decision });
        return accept;
      }}
    />,
  );
  mounted.push(view);
  const recipe = (): HTMLElement =>
    must(view.container.querySelector<HTMLElement>('[data-login-recipe]'), 'the recipe section');
  return { view, puts, decisions, recipe };
};

describe('the recipe', () => {
  it('shows the saved recipe read-only', async () => {
    const { recipe } = await show(recipeLogins());

    expect(recipe().textContent).toContain('Press Continue with Google');
    expect(recipe().querySelector('textarea')).toBeNull();
  });

  it('shows the recipe as plain text, so a link or an image in it is only words', async () => {
    const { recipe } = await show(
      recipeLogins({ recipe: 'Open [the site](https://evil.example.test) ![x](https://beacon.example.test/x.png)' }),
    );

    expect(recipe().querySelector('img')).toBeNull();
    expect(recipe().querySelector('a')).toBeNull();
    expect(recipe().textContent).toContain('![x](https://beacon.example.test/x.png)');
  });

  it('says when a ferret wrote the recipe and nobody reviewed it', async () => {
    const { recipe } = await show(recipeLogins({ recipeBy: 'ferret' }));

    expect(recipe().querySelector('[data-login-recipe-unreviewed]')?.textContent).toContain(
      'Written by a ferret, not reviewed',
    );
    const { recipe: owners } = await show(recipeLogins());
    expect(owners().querySelector('[data-login-recipe-unreviewed]')).toBeNull();
  });

  it('says there is none, and offers to add one, when the login has no recipe', async () => {
    const { recipe } = await show(logins({ entries: [login()] }));

    expect(recipe().querySelector('[data-login-recipe-empty]')).not.toBeNull();
    expect(byText(recipe(), 'button', 'Add recipe')).not.toBeNull();
    expect(recipe().textContent).not.toContain('Remove recipe');
  });

  it('saves an edited recipe with PUT {recipe}', async () => {
    const { recipe, puts } = await show(recipeLogins({ proposals: undefined }));

    await click(byText(recipe(), 'button', 'Edit recipe'));
    const area = must(recipe().querySelector<HTMLTextAreaElement>('textarea'), 'the editor');
    expect(area.value).toBe(BASE_RECIPE);
    await typeIntoTextarea(area, 'Open app.example.test\nDone when the dashboard shows');
    await click(byText(recipe(), 'button', 'Save recipe'));
    await settle();

    expect(puts).toEqual([
      { id: 'EXAMPLE_APP', body: { recipe: 'Open app.example.test\nDone when the dashboard shows' } },
    ]);
    expect(recipe().querySelector('textarea')).toBeNull();
  });

  it('leaves the editor alone on Cancel and sends nothing', async () => {
    const { recipe, puts } = await show(recipeLogins());

    await click(byText(recipe(), 'button', 'Edit recipe'));
    await typeIntoTextarea(recipe().querySelector('textarea'), 'something else');
    await click(byText(recipe(), 'button', 'Cancel'));

    expect(puts).toEqual([]);
    expect(recipe().querySelector('textarea')).toBeNull();
  });

  it('removes the recipe by sending {recipe: null}', async () => {
    const { recipe, puts } = await show(recipeLogins());

    await click(byText(recipe(), 'button', 'Remove recipe'));
    await settle();

    expect(puts).toEqual([{ id: 'EXAMPLE_APP', body: { recipe: null } }]);
  });

  it("shows the daemon's refusal beside the editor and keeps the text", async () => {
    const refusal = 'That recipe holds a saved value, so it was not saved.';
    const { recipe } = await show(recipeLogins(), refusal, false);

    await click(byText(recipe(), 'button', 'Edit recipe'));
    await typeIntoTextarea(recipe().querySelector('textarea'), 'Type hunter2-hunter2');
    await click(byText(recipe(), 'button', 'Save recipe'));
    await settle();

    expect(recipe().querySelector('[data-login-recipe-error]')?.textContent).toBe(refusal);
    expect(recipe().querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Type hunter2-hunter2');
  });
});

describe('what Ferretry saw', () => {
  it('has one row per observed place, in the daemon’s words', async () => {
    const { recipe } = await show(recipeLogins());
    const rows = [...recipe().querySelectorAll('[data-login-observed] li')].map(row => row.textContent);

    expect(rows).toEqual([
      'accounts.example.test: password field, no echo, moved on, 2FA by approval (seen 3×, 2026-10-28)',
      'sudo@kirin-box: typing hidden (seen 2×, 2026-10-28)',
    ]);
  });

  it('shows nothing when nothing was seen', async () => {
    const { recipe } = await show(recipeLogins({ observed: undefined }));

    expect(recipe().querySelector('[data-login-observed]')).toBeNull();
    expect(recipe().textContent).not.toContain('What Ferretry saw');
  });
});

describe('proposals', () => {
  it('shows the diff, the ferret’s reason and the date', async () => {
    const { recipe } = await show(recipeLogins());
    const proposal = must(
      recipe().querySelector<HTMLElement>(`[data-login-proposal="${PROPOSAL_ID}"]`),
      'the proposal',
    );
    const ops = [...proposal.querySelectorAll('[data-diff-op]')].map(line => [
      line.getAttribute('data-diff-op'),
      line.textContent,
    ]);

    expect(proposal.textContent).toContain('The ferret says: The sign-in asked which account to use.');
    expect(proposal.textContent).toContain('2026-10-30');
    expect(ops).toEqual([
      [' ', '  Open app.example.test'],
      [' ', '  Press Continue with Google'],
      ['+', '+ Pick the work account'],
      [' ', '  Wait for the phone approval'],
    ]);
  });

  it('shows a removed line as removed', async () => {
    const { recipe } = await show(
      recipeLogins({
        proposals: [
          {
            id: PROPOSAL_ID,
            recipe: 'Open app.example.test',
            base: BASE_RECIPE,
            why: 'The other steps were not needed.',
            sessionId: 'session-1',
            proposedAt: '2026-10-30T08:30:00.000Z',
          },
        ],
      }),
    );

    expect(recipe().querySelectorAll('[data-diff-op="-"]')).toHaveLength(2);
  });

  it('shows nothing about proposals when there are none', async () => {
    const { recipe } = await show(recipeLogins({ proposals: undefined }));

    expect(recipe().querySelector('[data-login-proposals]')).toBeNull();
  });

  it('approves and declines through onDecide', async () => {
    const { recipe, decisions } = await show(recipeLogins());

    await click(byText(recipe(), 'button', 'Approve'));
    await click(byText(recipe(), 'button', 'Decline'));
    await settle();

    expect(decisions).toEqual([
      { id: 'EXAMPLE_APP', proposalId: PROPOSAL_ID, decision: 'approve' },
      { id: 'EXAMPLE_APP', proposalId: PROPOSAL_ID, decision: 'decline' },
    ]);
  });
});

describe('the auto-apply switch', () => {
  it('is off by default and turns on with PUT {autoApplyRecipe: true}', async () => {
    const { recipe, puts } = await show(recipeLogins());
    const toggle = must(recipe().querySelector<HTMLInputElement>('[data-login-auto-apply]'), 'the toggle');

    expect(toggle.checked).toBe(false);
    expect(recipe().textContent).toContain('Apply ferret recipe changes without asking');
    await click(toggle);
    await settle();

    expect(puts).toEqual([{ id: 'EXAMPLE_APP', body: { autoApplyRecipe: true } }]);
  });

  it('reads as on, and turns off with {autoApplyRecipe: false}', async () => {
    const { recipe, puts } = await show(recipeLogins({ autoApplyRecipe: true }));
    const toggle = must(recipe().querySelector<HTMLInputElement>('[data-login-auto-apply]'), 'the toggle');

    expect(toggle.checked).toBe(true);
    await click(toggle);
    await settle();

    expect(puts).toEqual([{ id: 'EXAMPLE_APP', body: { autoApplyRecipe: false } }]);
  });
});

describe('through the surface', () => {
  const CONNECTION = daemonConnection({
    daemonId: 'workshop',
    baseUrl: 'https://workshop.example.test',
    deviceId: 't1',
  });

  it('posts the decision to the proposal route and shows the list the daemon then holds', async () => {
    let list = recipeLogins();
    const fake = fakeClient(call => {
      if (call.method === 'POST') {
        list = recipeLogins({ recipe: NEXT_RECIPE, proposals: undefined });
        return list.entries[0];
      }
      return list;
    });
    const view = await mount(<LoginsSurface connection={CONNECTION} createClient={async () => fake.client} />);
    mounted.push(view);
    await settle();

    await click(byText(view.container, 'button', 'Approve'));
    await settle();

    const post = fake.calls.find(call => call.method === 'POST');
    expect(post).toEqual({
      path: `/v1/secrets/logins/EXAMPLE_APP/recipe/proposals/${PROPOSAL_ID}`,
      method: 'POST',
      body: { decision: 'approve' },
    });
    expect(view.container.textContent).toContain('Pick the work account');
    expect(view.container.querySelector('[data-login-proposals]')).toBeNull();
  });

  it('shows a stale refusal beside the proposal and keeps Decline available', async () => {
    const stale = 'The recipe changed since this was proposed. Decline it or edit the recipe by hand.';
    const fake = fakeClient(call => {
      if (call.method === 'POST') throw new Error(stale);
      return recipeLogins();
    });
    const view = await mount(<LoginsSurface connection={CONNECTION} createClient={async () => fake.client} />);
    mounted.push(view);
    await settle();

    await click(byText(view.container, 'button', 'Approve'));
    await settle();

    expect(view.container.querySelector('[data-login-recipe-error]')?.textContent).toBe(stale);
    expect(view.container.querySelectorAll('[data-testid="logins-error"]')).toHaveLength(0);
    expect(byText(view.container, 'button', 'Decline').hasAttribute('disabled')).toBe(false);
  });

  it('keeps an unrelated refusal in the card’s own message', async () => {
    const fake = fakeClient(call => {
      if (call.method === 'DELETE') throw new Error('the vault is locked');
      return logins({ entries: [withRecipe()] });
    });
    const view = await mount(<LoginsSurface connection={CONNECTION} createClient={async () => fake.client} />);
    mounted.push(view);
    await settle();

    await click(view.container.querySelector('[aria-label="Delete Example app"]'));
    await click(view.container.querySelector('[data-login-confirm-delete]'));
    await settle();

    expect(view.container.querySelector('[data-testid="logins-error"]')?.textContent).toBe('the vault is locked');
    expect(view.container.querySelector('[data-login-recipe-error]')).toBeNull();
  });
});
