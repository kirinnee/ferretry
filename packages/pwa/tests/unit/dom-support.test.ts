import { afterEach, describe, expect, it } from 'bun:test';
import { INSPECTED_NODE_LIMIT, must } from '../support/dom.ts';

const OBSERVED_ATTRIBUTE = 'data-mutation-observer-probe';

afterEach(() => {
  document.documentElement.removeAttribute(OBSERVED_ATTRIBUTE);
  for (const probe of document.querySelectorAll('[data-inspect-probe]')) probe.remove();
});

describe('the happy-dom test environment', () => {
  it('prints a connected node as its text and markup, not as the document it reaches', () => {
    const alert = document.createElement('p');
    alert.setAttribute('data-inspect-probe', '');
    alert.setAttribute('role', 'alert');
    alert.textContent = 'This machine didn’t answer.';
    document.body.appendChild(alert);

    expect(Bun.inspect(alert)).toBe(
      'HTMLParagraphElement "This machine didn’t answer." <p data-inspect-probe="" role="alert">This machine didn’t answer.</p>',
    );
    expect(Bun.inspect(must(alert.firstChild, 'text'))).toBe('Text "This machine didn’t answer."');
    // What a failed matcher prints: the same line, so a failure costs nothing to report.
    let failure = '';
    try {
      expect(alert).toBeNull();
    } catch (error) {
      failure = String(error);
    }
    expect(failure).toContain('Received: HTMLParagraphElement "This machine didn’t answer." <p data-inspect-probe');
    expect(failure.length).toBeLessThan(2 * INSPECTED_NODE_LIMIT);
  });

  it('caps a large subtree and says how much it left out', () => {
    const list = document.createElement('ul');
    list.setAttribute('data-inspect-probe', '');
    for (let item = 0; item < 200; item += 1) list.appendChild(document.createElement('li')).textContent = 'item';
    document.body.appendChild(list);

    const printed = Bun.inspect(list);
    const text = list.textContent ?? '';
    const markup = list.outerHTML;
    expect(printed).toBe(
      `HTMLUListElement "${text.slice(0, INSPECTED_NODE_LIMIT)}… (${text.length - INSPECTED_NODE_LIMIT} more characters)" ` +
        `${markup.slice(0, INSPECTED_NODE_LIMIT)}… (${markup.length - INSPECTED_NODE_LIMIT} more characters)`,
    );
  });
});
