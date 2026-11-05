import { describe, expect, it } from 'bun:test';
import { SECRET_SCHEMA_VERSION, type SecretList } from '@ferretry/protocol';
import { SecretsCard } from '../../../src/features/secrets/secrets-card.tsx';
import { interact, mount, must } from '../../support/dom.ts';

const AT = '2026-08-05T10:00:00.000Z';

const list = (): SecretList => ({
  v: SECRET_SCHEMA_VERSION,
  health: 'ready',
  secrets: [{ name: 'ANTHROPIC_API_KEY', createdAt: AT, updatedAt: AT }],
  references: [],
});

describe('SecretsCard › the ⋯ menu', () => {
  it('keeps Delete behind the ⋯ button and removes by name from there', async () => {
    // Arrange
    const removed: string[] = [];
    const view = await mount(
      <SecretsCard
        list={list()}
        onPut={() => undefined}
        onRemove={name => {
          removed.push(name);
        }}
      />,
    );
    const more = must(
      view.container.querySelector<HTMLButtonElement>('[aria-label="More actions for ANTHROPIC_API_KEY"]'),
      'the more button',
    );

    // Assert — a row carries Replace and ⋯, and Delete is not on the row itself.
    expect(view.container.querySelector('[aria-label="Delete ANTHROPIC_API_KEY"]')).toBeNull();
    expect(document.querySelector('[role="menuitem"]')).toBeNull();

    // Act
    await interact(() => more.click());
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const item = must(document.querySelector<HTMLButtonElement>('[data-menu-key="delete"]'), 'the Delete item');
    expect(item.textContent).toContain('Delete ANTHROPIC_API_KEY');
    await interact(() => item.click());

    // Assert
    expect(removed).toEqual(['ANTHROPIC_API_KEY']);
    await view.unmount();
  });
});
