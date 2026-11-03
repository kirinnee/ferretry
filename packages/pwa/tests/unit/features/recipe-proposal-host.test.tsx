/** A ferret's suggested sign-in recipe, answered on its card: read from the accounts listing, never from the item's text. */

import { describe, expect, it } from 'bun:test';
import { LOGIN_RECIPE_MAX_LENGTH } from '@ferretry/protocol';
import { RecipeProposalHost } from '../../../src/features/secrets/recipe-proposal-host.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { RECIPE_OBSOLETE_WORDS, RECIPE_STALE_WORDS } from '../../../src/lib/recipe-proposal.ts';
import { daemonSettingsPath } from '../../../src/lib/pages/routes.ts';
import { list, PROPOSAL, SI_GITHUB } from '../../support/accounts-fixtures.ts';
import { mount, must } from '../../support/dom.ts';
import { click, settle, typeInto } from '../../support/dom-form.ts';
import { type Call, fakeClient } from '../../support/input-fixtures.ts';
import { refused } from '../../support/sign-in-rule-client.ts';

const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example', deviceId: 'phone-1' });
const ref = { recipeProposal: { signIn: SI_GITHUB, id: PROPOSAL } };
const DECISION_PATH = `/v1/accounts/sign-ins/${SI_GITHUB}/recipe/proposals/${PROPOSAL}`;
const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);
const text = (root: ParentNode, selector: string): string => q(root, selector).textContent ?? '';
const decisions = (calls: readonly Call[]): Call[] => calls.filter(call => call.method === 'POST');
const disabled = (root: ParentNode, selector: string): boolean => q<HTMLButtonElement>(root, selector).disabled;

/** A promise the test settles by hand, to hold a read or a decision in flight. */
const deferred = <T,>() => {
  let release!: (value: T) => void;
  const promise = new Promise<T>(resolve => {
    release = resolve;
  });
  return { promise, release };
};

/** The listing as the daemon holds it after someone changed the sign-in's recipe under the proposal. */
const recipeChangedTo = (recipe: string, version: number) => {
  const accounts = list();
  return {
    ...accounts,
    signIns: accounts.signIns.map(each => (each.id === SI_GITHUB ? { ...each, recipe, recipeVersion: version } : each)),
  };
};

interface World {
  /** What reading the accounts does; a function is asked on every read. */
  readonly accounts?: () => unknown;
  readonly decide?: (call: Call) => unknown;
}

const host = (world: World = {}, props: Partial<Parameters<typeof RecipeProposalHost>[0]> = {}) => {
  const fake = fakeClient(call => {
    if (call.method === 'GET') return (world.accounts ?? list)();
    if (call.path === DECISION_PATH) return (world.decide ?? (() => list().signIns[0]))(call);
    throw new Error(`no answer for ${call.method} ${call.path}`);
  });
  return {
    fake,
    element: (
      <RecipeProposalHost connection={connection} createClient={async () => fake.client} item={ref} {...props} />
    ),
  };
};

const withMounted = async (
  element: React.ReactElement,
  run: (container: HTMLElement) => Promise<void>,
): Promise<void> => {
  const mounted = await mount(element);
  try {
    await settle();
    await run(mounted.container);
  } finally {
    await mounted.unmount();
  }
};

describe('the recipe card', () => {
  it('draws the place, what changed, the steps, the ferret’s quoted words and what Ferretry itself saw', async () => {
    const { element } = host({}, { agentName: 'Hadi' });
    await withMounted(element, async root => {
      expect(text(root, '[data-recipe-title]')).toBe('Sign-in steps for github.com');
      expect(text(root, '[data-recipe-change]')).toBe('v2 → proposed · 1 added, 1 removed');
      const kinds = [...root.querySelectorAll('[data-recipe-step]')].map(step => step.getAttribute('data-recipe-step'));
      expect(kinds).toEqual(['removed', 'added']);
      expect(text(root, '[data-recipe-why]')).toBe('Hadi says: “The button moved”');
      expect(q(root, '[data-recipe-saw]').textContent).toContain('What Ferretry saw');
      expect(q(root, '[data-recipe-approves]').textContent).toContain('never holds a password or a code');
      expect(q(root, '[data-recipe-decline]').textContent).toContain('Decline');
      expect(q(root, '[data-recipe-edit]').textContent).toContain('Edit');
      expect(q(root, '[data-recipe-approve]').textContent).toContain('Approve');
    });
  });

  it('calls the ferret “The ferret” when it has no name', async () => {
    const { element } = host();
    await withMounted(element, async root => {
      expect(text(root, '[data-recipe-why]')).toStartWith('The ferret says:');
    });
  });

  it('approves the ferret’s version with no recipe in the body', async () => {
    const { element, fake } = host();
    await withMounted(element, async root => {
      await click(q(root, '[data-recipe-approve]'));
      await settle();

      expect(decisions(fake.calls)).toEqual([{ path: DECISION_PATH, method: 'POST', body: { decision: 'approve' } }]);
      expect(text(root, '[data-recipe-done]')).toBe('Recipe for github.com approved.');
      expect(root.querySelector('[data-recipe-proposal]')).toBeNull();
    });
  });

  it('declines', async () => {
    const { element, fake } = host();
    await withMounted(element, async root => {
      await click(q(root, '[data-recipe-decline]'));
      await settle();

      expect(decisions(fake.calls).map(call => call.body)).toEqual([{ decision: 'decline' }]);
      expect(text(root, '[data-recipe-done]')).toBe('Declined.');
    });
  });

  it('edits right on the card, prefilled, and approves the owner’s own version', async () => {
    const { element, fake } = host();
    await withMounted(element, async root => {
      await click(q(root, '[data-recipe-edit]'));
      const area = q<HTMLTextAreaElement>(root, '[data-recipe-text]');
      expect(area.value).toBe('Open the page, press Sign in, type the code.');
      expect(area.maxLength).toBe(LOGIN_RECIPE_MAX_LENGTH);
      expect(root.querySelector('[data-recipe-saw]')).toBeNull();

      await typeInto(area, 'Open the page, press Sign in, wait.', 'textarea');
      await click(q(root, '[data-recipe-approve-mine]'));
      await settle();

      expect(decisions(fake.calls).map(call => call.body)).toEqual([
        { decision: 'approve', recipe: 'Open the page, press Sign in, wait.' },
      ]);
      expect(text(root, '[data-recipe-done]')).toBe('Recipe for github.com approved.');
    });
  });

  it('goes back to the steps on Cancel without sending anything', async () => {
    const { element, fake } = host();
    await withMounted(element, async root => {
      await click(q(root, '[data-recipe-edit]'));
      await click(q(root, '[data-recipe-cancel]'));

      expect(q(root, '[data-recipe-proposal]').getAttribute('data-recipe-mode')).toBe('view');
      expect(decisions(fake.calls)).toEqual([]);
    });
  });

  it('will not send an empty recipe of its own', async () => {
    const { element, fake } = host();
    await withMounted(element, async root => {
      await click(q(root, '[data-recipe-edit]'));
      await typeInto(q(root, '[data-recipe-text]'), '   ', 'textarea');

      expect(text(root, '[data-recipe-problem]')).toBe('Write the steps first.');
      expect(q<HTMLButtonElement>(root, '[data-recipe-approve-mine]').disabled).toBe(true);
      expect(decisions(fake.calls)).toEqual([]);
    });
  });

  it('says the recipe changed on a stale proposal and reads the steps again', async () => {
    let reads = 0;
    const { element, fake } = host({
      accounts: () => {
        reads += 1;
        return reads === 1 ? list() : recipeChangedTo('# Sign in', 3);
      },
      decide: () => {
        throw refused('refused', { status: 409, code: 'stale_proposal' });
      },
    });
    await withMounted(element, async root => {
      await click(q(root, '[data-recipe-approve]'));
      await settle();

      expect(text(root, '[data-recipe-stale]')).toBe(RECIPE_STALE_WORDS);
      expect(reads).toBe(2);
      expect(decisions(fake.calls)).toHaveLength(1);
      // The recipe is back at what the proposal was made from, so the owner can decide again on what they now see.
      expect(disabled(root, '[data-recipe-approve]')).toBe(false);
      expect(root.querySelector('[data-recipe-settings]')).toBeNull();
    });
  });

  it('keeps every answer off while the steps are read again, then shows the current recipe and blocks an obsolete base', async () => {
    const reread = deferred<unknown>();
    let reads = 0;
    const holding: boolean[] = [];
    const { element, fake } = host(
      {
        accounts: () => {
          reads += 1;
          return reads === 1 ? list() : reread.promise;
        },
        decide: () => {
          throw refused('refused', { status: 409, code: 'stale_proposal' });
        },
      },
      { onHold: isHolding => void holding.push(isHolding) },
    );
    await withMounted(element, async root => {
      await click(q(root, '[data-recipe-approve]'));
      await settle();

      // The re-read is in flight: nothing can be answered, and the owner is told why.
      expect(text(root, '[data-recipe-stale]')).toBe(RECIPE_STALE_WORDS);
      expect(disabled(root, '[data-recipe-approve]')).toBe(true);
      expect(disabled(root, '[data-recipe-decline]')).toBe(true);
      expect(disabled(root, '[data-recipe-edit]')).toBe(true);
      expect(holding.at(-1)).toBe(true);

      reread.release(recipeChangedTo('Open the page and wait.', 3));
      await settle();

      // The card now diffs against what the daemon holds, labelled with its version.
      expect(text(root, '[data-recipe-change]')).toBe('v3 → proposed · 1 added, 1 removed');
      const steps = [...root.querySelectorAll('[data-recipe-step]')].map(step => step.textContent);
      expect(steps).toEqual([
        '−Removed: Open the page and wait.',
        '+1Added: Open the page, press Sign in, type the code.',
      ]);
      // The proposal was made from a recipe that is gone: no approval can succeed, and the card says where to go.
      expect(text(root, '[data-recipe-stale]')).toBe(RECIPE_OBSOLETE_WORDS);
      expect(disabled(root, '[data-recipe-approve]')).toBe(true);
      expect(disabled(root, '[data-recipe-decline]')).toBe(false);
      expect(q<HTMLAnchorElement>(root, '[data-recipe-settings]').getAttribute('href')).toBe(
        `${daemonSettingsPath(connection.daemonId)}#accounts`,
      );
      expect(holding.at(-1)).toBe(false);
      expect(decisions(fake.calls)).toHaveLength(1);
    });
  });

  it('keeps the owner’s own text, and blocks sending it, when the base it was written on is obsolete', async () => {
    let reads = 0;
    const { element } = host({
      accounts: () => {
        reads += 1;
        return reads === 1 ? list() : recipeChangedTo('Open the page and wait.', 3);
      },
      decide: () => {
        throw refused('refused', { status: 409, code: 'stale_proposal' });
      },
    });
    await withMounted(element, async root => {
      await click(q(root, '[data-recipe-edit]'));
      await typeInto(q(root, '[data-recipe-text]'), 'My own steps', 'textarea');
      await click(q(root, '[data-recipe-approve-mine]'));
      await settle();

      expect(q<HTMLTextAreaElement>(root, '[data-recipe-text]').value).toBe('My own steps');
      expect(text(root, '[data-recipe-stale]')).toBe(RECIPE_OBSOLETE_WORDS);
      expect(disabled(root, '[data-recipe-approve-mine]')).toBe(true);
      expect(disabled(root, '[data-recipe-cancel]')).toBe(false);
      expect(root.querySelector('[data-recipe-settings]')).not.toBeNull();
    });
  });

  it('leaves the textarea read-only while the owner’s version is on its way', async () => {
    const answer = deferred<unknown>();
    const { element } = host({ decide: () => answer.promise });
    await withMounted(element, async root => {
      await click(q(root, '[data-recipe-edit]'));
      const area = q<HTMLTextAreaElement>(root, '[data-recipe-text]');
      expect(area.readOnly).toBe(false);
      await click(q(root, '[data-recipe-approve-mine]'));

      expect(area.readOnly).toBe(true);
      expect(disabled(root, '[data-recipe-approve-mine]')).toBe(true);

      answer.release(list().signIns[0]);
      await settle();

      expect(text(root, '[data-recipe-done]')).toBe('Recipe for github.com approved.');
    });
  });

  it('keeps what the owner typed when a decision fails, and says why in words', async () => {
    const { element } = host({
      decide: () => {
        throw refused('The secret store is damaged.', { status: 500 });
      },
    });
    await withMounted(element, async root => {
      await click(q(root, '[data-recipe-edit]'));
      await typeInto(q(root, '[data-recipe-text]'), 'My own steps', 'textarea');
      await click(q(root, '[data-recipe-approve-mine]'));
      await settle();

      expect(text(root, '[data-recipe-error]')).toBe('The secret store is damaged.');
      expect(q<HTMLTextAreaElement>(root, '[data-recipe-text]').value).toBe('My own steps');
    });
  });

  it('closes the card, keeping its words, when the proposal is gone after a stale refusal', async () => {
    let reads = 0;
    const { element } = host({
      accounts: () => {
        reads += 1;
        const accounts = list();
        return reads === 1
          ? accounts
          : { ...accounts, signIns: accounts.signIns.map(each => ({ ...each, proposals: [] })) };
      },
      decide: () => {
        throw refused('refused', { status: 409, code: 'stale_proposal' });
      },
    });
    await withMounted(element, async root => {
      await click(q(root, '[data-recipe-approve]'));
      await settle();

      expect(text(root, '[data-recipe-stale]')).toBe(RECIPE_STALE_WORDS);
      expect(root.querySelector('[data-recipe-actions]')).toBeNull();
    });
  });

  it('closes the card the same way when the steps cannot be read again after a stale refusal', async () => {
    let reads = 0;
    const { element } = host({
      accounts: () => {
        reads += 1;
        if (reads === 1) return list();
        throw refused('The machine is not answering.', { status: 503 });
      },
      decide: () => {
        throw refused('refused', { status: 409, code: 'stale_proposal' });
      },
    });
    await withMounted(element, async root => {
      await click(q(root, '[data-recipe-approve]'));
      await settle();

      expect(text(root, '[data-recipe-stale]')).toBe(RECIPE_STALE_WORDS);
      expect(root.querySelector('[data-recipe-actions]')).toBeNull();
    });
  });
});

describe('when the card cannot be drawn', () => {
  it('draws nothing for a device that may not read accounts', async () => {
    const { element } = host({
      accounts: () => {
        throw refused('Forbidden', { status: 403, code: 'grant_forbidden' });
      },
    });
    await withMounted(element, async root => {
      expect(root.querySelector('[data-recipe-proposal]')).toBeNull();
      expect(root.textContent).toBe('');
    });
  });

  it('draws nothing for a proposal the daemon no longer holds', async () => {
    const { element } = host({}, { item: { recipeProposal: { signIn: SI_GITHUB, id: 'rp_ffffffffffffffff' } } });
    await withMounted(element, async root => {
      expect(root.querySelector('[data-recipe-proposal]')).toBeNull();
      expect(root.textContent).toBe('');
    });
  });

  it('draws nothing for an item that names no proposal', async () => {
    const { element, fake } = host({}, { item: {} });
    await withMounted(element, async root => {
      expect(root.textContent).toBe('');
      expect(fake.calls).toEqual([]);
    });
  });
});

describe('holding the view it is drawn in', () => {
  const holds = () => {
    const told: Array<{ holding: boolean; settled?: string | undefined }> = [];
    return { told, onHold: (holding: boolean, settled?: string) => void told.push({ holding, settled }) };
  };

  it('holds while the owner edits and lets go, with its words, once the decision is in', async () => {
    const { told, onHold } = holds();
    const { element } = host({}, { onHold });
    await withMounted(element, async root => {
      expect(told).toEqual([]);
      await click(q(root, '[data-recipe-edit]'));
      expect(told).toEqual([{ holding: true, settled: undefined }]);

      await click(q(root, '[data-recipe-approve-mine]'));
      await settle();

      expect(told).toEqual([
        { holding: true, settled: undefined },
        { holding: false, settled: 'Recipe for github.com approved.' },
      ]);
    });
  });

  it('lets go with “Declined.” after a plain decline, never holding on a card nobody touched', async () => {
    const { told, onHold } = holds();
    const { element } = host({}, { onHold });
    await withMounted(element, async root => {
      await click(q(root, '[data-recipe-decline]'));
      await settle();

      expect(told.at(-1)).toEqual({ holding: false, settled: 'Declined.' });
    });
  });

  it('lets go, and drops the owner’s edit, when the proposal turns out to be gone after a stale refusal', async () => {
    const { told, onHold } = holds();
    let reads = 0;
    const { element } = host(
      {
        accounts: () => {
          reads += 1;
          const accounts = list();
          return reads === 1
            ? accounts
            : { ...accounts, signIns: accounts.signIns.map(each => ({ ...each, proposals: [] })) };
        },
        decide: () => {
          throw refused('refused', { status: 409, code: 'stale_proposal' });
        },
      },
      { onHold },
    );
    await withMounted(element, async root => {
      await click(q(root, '[data-recipe-edit]'));
      await click(q(root, '[data-recipe-approve-mine]'));
      await settle();

      expect(told.at(-1)).toEqual({ holding: false, settled: undefined });
      expect(root.querySelector('[data-recipe-text]')).toBeNull();
      expect(root.querySelector('[data-recipe-actions]')).toBeNull();
    });
  });

  it('lets go without words when the owner cancels the edit', async () => {
    const { told, onHold } = holds();
    const { element } = host({}, { onHold });
    await withMounted(element, async root => {
      await click(q(root, '[data-recipe-edit]'));
      await click(q(root, '[data-recipe-cancel]'));

      expect(told).toEqual([
        { holding: true, settled: undefined },
        { holding: false, settled: undefined },
      ]);
    });
  });
});
