/**
 * The Secrets add row is one height: Name, Value and Save. Measured in a real browser the old row had Save at 44px beside
 * fields of 34.9px (the button's own `min-h-[44px]` against `.kt-input`'s control height). A DOM harness has no layout, so this
 * pins the two facts that produce the equal heights: the button carries no height of its own, and the row's stylesheet
 * gives the fields and the button the one `--vault-field-h`.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SecretsCard } from '../../../app/features/secrets/secrets-card.tsx';
import { mount, must } from '../../support/app/dom.ts';

const css = readFileSync(new URL('../../../app/features/secrets/vault.css', import.meta.url), 'utf8');

describe('the Secrets add row height', () => {
  it('gives Save no height of its own, so it cannot stand taller than the fields', async () => {
    const mounted = await mount(
      <SecretsCard
        list={{ v: 1, health: 'ready', secrets: [], references: [] }}
        onPut={async () => {}}
        onRemove={async () => {}}
      />,
    );
    try {
      const save = must(mounted.container.querySelector('button[type="submit"]'), 'the Save button');
      expect(save.className).not.toMatch(/\bmin-h-/);
    } finally {
      mounted.unmount();
    }
  });

  it('sizes the fields and the button from the one --vault-field-h', () => {
    const rule = css.match(/\.fy-vault-fields \.kt-input,\s*\.fy-vault-fields \.kt-btn\s*\{([^}]*)\}/);
    const body = must(rule?.[1], 'the shared field rule');
    expect(body).toContain('height: var(--vault-field-h)');
    expect(body).toContain('min-height: var(--vault-field-h)');
  });
});
