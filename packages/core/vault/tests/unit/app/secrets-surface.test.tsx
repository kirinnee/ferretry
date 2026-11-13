/**
 * S4: the Secrets page creates, replaces and deletes, and shows only that a secret exists, its name and when it last
 * changed. Driven through the real surface over a recording client; the only values are obvious fakes.
 */
import { describe, expect, it } from 'bun:test';
import { SecretsSurface } from '../../../app/features/secrets/secrets-surface.tsx';
import { click, settle, typeInto } from '../../support/app/dom-form.ts';
import { interact, mount, must } from '../../support/app/dom.ts';
import { FAKE_VALUE, recordingClient } from '../../support/app/input-fixtures.ts';

const CREATED = '2026-08-01T10:00:00.000Z';
const CHANGED = '2026-08-05T10:00:00.000Z';

const list = (secrets: readonly { name: string; createdAt: string; updatedAt: string }[]) => ({
  v: 1,
  health: 'ready',
  secrets,
  references: [],
});

/** A daemon with one secret in it, that files a put and forgets a delete. */
function daemon() {
  const held = [{ name: 'ANTHROPIC_KEY', createdAt: CREATED, updatedAt: CHANGED }];
  return recordingClient(async (route, init) => {
    if (route === 'GET /v1/secrets') return list(held);
    if (route === 'POST /v1/secrets') {
      const body = init?.body as { name: string };
      const at = '2026-08-06T10:00:00.000Z';
      const index = held.findIndex(each => each.name === body.name);
      const summary = { name: body.name, createdAt: index < 0 ? at : (held[index]?.createdAt ?? at), updatedAt: at };
      if (index < 0) held.push(summary);
      else held[index] = summary;
      return summary;
    }
    if (route === 'DELETE /v1/secrets/:name') {
      const name = init?.params?.name;
      held.splice(
        held.findIndex(each => each.name === name),
        1,
      );
      return { name, removed: true };
    }
    throw new Error(`unexpected ${route}`);
  });
}

const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);
const button = (root: ParentNode, label: string) =>
  must(
    [...root.querySelectorAll('button')].find(each => each.getAttribute('aria-label') === label),
    label,
  );

describe('the Secrets page', () => {
  it('S4 lists a secret by its name, a mask and when it changed, and never a value', async () => {
    const { client } = daemon();
    const mounted = await mount(<SecretsSurface client={client} />);
    await settle();
    try {
      const row = q(mounted.container, '[data-secret="ANTHROPIC_KEY"]');
      expect(row.textContent).toContain('ANTHROPIC_KEY');
      expect(row.textContent).toContain('••••••••••••');
      expect(row.textContent).toContain('changed 2026-08-05');
      // The only controls on a listed secret replace it or delete it: nothing reveals, copies or reads it back.
      expect([...row.querySelectorAll('button')].map(each => each.getAttribute('aria-label'))).toEqual([
        'Replace ANTHROPIC_KEY',
        'Delete ANTHROPIC_KEY',
      ]);
    } finally {
      await mounted.unmount();
    }
  });

  it('S4 refuses a listing that carries a value rather than draw any of it', async () => {
    const { client } = recordingClient(async () =>
      list([{ name: 'ANTHROPIC_KEY', createdAt: CREATED, updatedAt: CHANGED, value: FAKE_VALUE } as never]),
    );
    const mounted = await mount(<SecretsSurface client={client} />);
    await settle();
    try {
      expect(mounted.container.textContent).toContain('Secrets unavailable');
      expect(mounted.container.querySelector('[data-secret]')).toBeNull();
      expect(mounted.container.innerHTML).not.toContain(FAKE_VALUE);
    } finally {
      await mounted.unmount();
    }
  });

  it('S4 creates a secret, sends the value once, clears the field at once and shows the name afterwards', async () => {
    const { client, calls } = daemon();
    const mounted = await mount(<SecretsSurface client={client} />);
    await settle();
    try {
      const form = q(mounted.container, 'form');
      const name = q<HTMLInputElement>(form, 'input:not([type=password])');
      const value = q<HTMLInputElement>(form, 'input[type=password]');
      await typeInto(name, 'new_token');
      await typeInto(value, FAKE_VALUE);
      expect(name.value).toBe('NEW_TOKEN');
      await interact(() => {
        q<HTMLButtonElement>(form, 'button[type=submit]').click();
      });
      // The value left the field when Save was pressed.
      expect(value.value).toBe('');
      await settle();
      const put = must(
        calls.find(each => each.route === 'POST /v1/secrets'),
        'a put',
      );
      expect(put.init?.body).toEqual({ name: 'NEW_TOKEN', value: FAKE_VALUE });
      expect(q(mounted.container, '[data-secret="NEW_TOKEN"]').textContent).toContain('set 2026-08-06');
      // Neither the page nor any call after the put carries the value again.
      expect(mounted.container.innerHTML).not.toContain(FAKE_VALUE);
      expect(JSON.stringify(calls.filter(each => each.init?.body === undefined))).not.toContain(FAKE_VALUE);
    } finally {
      await mounted.unmount();
    }
  });

  it('S4 replaces a secret by naming it, saying it is a replacement, and shows it as changed', async () => {
    const { client, calls } = daemon();
    const mounted = await mount(<SecretsSurface client={client} />);
    await settle();
    try {
      await click(button(mounted.container, 'Replace ANTHROPIC_KEY'));
      const form = q(mounted.container, 'form');
      await typeInto(q(form, 'input[type=password]'), FAKE_VALUE);
      expect(form.textContent).toContain('ANTHROPIC_KEY already exists — saving replaces it.');
      await interact(() => {
        q<HTMLButtonElement>(form, 'button[type=submit]').click();
      });
      await settle();
      expect(calls.some(each => each.route === 'POST /v1/secrets')).toBe(true);
      expect(q(mounted.container, '[data-secret="ANTHROPIC_KEY"]').textContent).toContain('changed 2026-08-06');
    } finally {
      await mounted.unmount();
    }
  });

  it('S4 deletes a secret by its name and the list no longer shows it', async () => {
    const { client, calls } = daemon();
    const mounted = await mount(<SecretsSurface client={client} />);
    await settle();
    try {
      await click(button(mounted.container, 'Delete ANTHROPIC_KEY'));
      await settle();
      const removal = must(
        calls.find(each => each.route === 'DELETE /v1/secrets/:name'),
        'a delete',
      );
      expect(removal.init?.params).toEqual({ name: 'ANTHROPIC_KEY' });
      expect(mounted.container.querySelector('[data-secret]')).toBeNull();
      expect(q(mounted.container, '[data-testid="secrets-empty"]').textContent).toContain('No secrets');
    } finally {
      await mounted.unmount();
    }
  });

  it('S4 clears the value field when the page is hidden', async () => {
    const { client } = daemon();
    const mounted = await mount(<SecretsSurface client={client} />);
    await settle();
    const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    try {
      const value = q<HTMLInputElement>(mounted.container, 'input[type=password]');
      await typeInto(value, FAKE_VALUE);
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      await interact(() => document.dispatchEvent(new Event('visibilitychange')));
      expect(value.value).toBe('');
    } finally {
      if (original === undefined) Reflect.deleteProperty(document, 'visibilityState');
      else Object.defineProperty(document, 'visibilityState', original);
      await mounted.unmount();
    }
  });

  it('S4 says a store it could not read is unreadable, never that it is empty', async () => {
    const { client } = recordingClient(async () => {
      throw new Error('the daemon did not answer');
    });
    const mounted = await mount(<SecretsSurface client={client} />);
    await settle();
    try {
      expect(mounted.container.textContent).toContain('Secrets unavailable');
      expect(mounted.container.textContent).toContain('not the same as an empty store');
      expect(mounted.container.querySelector('[data-testid="secrets-empty"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('S4 warns a damaged store is not empty and lists nothing to set over', async () => {
    const { client } = recordingClient(async () => ({
      v: 1,
      health: 'damaged',
      diagnosis: 'vault.key is missing',
      secrets: [],
      references: [],
    }));
    const mounted = await mount(<SecretsSurface client={client} />);
    await settle();
    try {
      expect(q(mounted.container, '[data-testid="secrets-damaged"]').textContent).toContain('It is not empty');
      expect(mounted.container.querySelector('[data-testid="secrets-empty"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
