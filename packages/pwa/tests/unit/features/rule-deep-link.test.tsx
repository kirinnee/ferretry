/** `<app>/#rules/<stage>` (printed by `fy rules add`): routed to a machine's Secure copy panel, highlighted only if listed, never a passkey ask. */

import { afterEach, describe, expect, it } from 'bun:test';
import { SignInRulesSurface } from '../../../src/features/secure-copy/sign-in-rules-surface.tsx';
import { useRuleDeepLink } from '../../../src/hooks/use-rule-deep-link.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import {
  captureRuleDeepLink,
  clearRuleDeepLink,
  markRuleDeepLinkRouted,
  pendingRuleDeepLink,
  ruleStageFromHash,
  subscribeRuleDeepLink,
} from '../../../src/lib/rule-deep-link.ts';
import { RULE_LINKED_STAGE_GONE_WORDS } from '../../../src/lib/sign-in-rules.ts';
import { mount, must } from '../../support/dom.ts';
import { settle } from '../../support/dom-form.ts';
import { refused, ruleClient } from '../../support/sign-in-rule-client.ts';
import { machineStage, ruleList, STAGE_ID } from '../../support/sign-in-rule-fixtures.ts';

const hereAt = (hash: string) => ({ hash, pathname: '/app/', search: '?x=1' });
const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example', deviceId: 'phone-1' });
const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);

afterEach(() => clearRuleDeepLink());

describe('reading the fragment', () => {
  it('accepts a stage id and nothing else', () => {
    expect(ruleStageFromHash(`#rules/${STAGE_ID}`)).toBe(STAGE_ID);
    expect(ruleStageFromHash(`rules/${STAGE_ID}`)).toBe(STAGE_ID);
    expect(ruleStageFromHash('#rules/not-a-stage')).toBeNull();
    expect(ruleStageFromHash('#rules/')).toBeNull();
    expect(ruleStageFromHash('#rules')).toBeNull();
    expect(ruleStageFromHash(`#rules/${STAGE_ID}/extra`)).toBeNull();
    expect(ruleStageFromHash(`#agenda/${STAGE_ID}`)).toBeNull();
    expect(ruleStageFromHash('#rules/%E0%A4%A')).toBeNull();
  });

  it('holds a valid link, tells the listeners and takes the fragment out of the address bar', () => {
    let heard = 0;
    const stop = subscribeRuleDeepLink(() => {
      heard += 1;
    });
    captureRuleDeepLink(hereAt(`#rules/${STAGE_ID}`));
    expect(pendingRuleDeepLink()).toEqual({ stage: STAGE_ID, routed: false });
    expect(window.location.hash).toBe('');
    markRuleDeepLinkRouted();
    markRuleDeepLinkRouted();
    expect(pendingRuleDeepLink()).toEqual({ stage: STAGE_ID, routed: true });
    expect(heard).toBe(2);
    stop();
    clearRuleDeepLink();
    clearRuleDeepLink();
    expect(heard).toBe(2);
  });

  it('ignores an invalid stage id, leaving the address alone', () => {
    captureRuleDeepLink(hereAt('#rules/bogus'));
    expect(pendingRuleDeepLink()).toBeNull();
    markRuleDeepLinkRouted();
    expect(pendingRuleDeepLink()).toBeNull();
  });
});

describe('routing the link', () => {
  function Probe({
    machine,
    paired,
    navigate,
  }: {
    readonly machine: { readonly secureCopyPath: string } | null;
    readonly paired: boolean;
    readonly navigate: (to: string) => void;
  }) {
    useRuleDeepLink(machine, paired, navigate);
    return null;
  }
  const here = { secureCopyPath: '/m/studio/settings#machine-secure-copy' };

  it('goes to the active machine’s Secure copy panel once, keeping the stage for the panel', async () => {
    const went: string[] = [];
    captureRuleDeepLink(hereAt(`#rules/${STAGE_ID}`));
    const mounted = await mount(<Probe machine={here} navigate={to => went.push(to)} paired />);
    try {
      expect(went).toEqual([here.secureCopyPath]);
      expect(pendingRuleDeepLink()).toEqual({ stage: STAGE_ID, routed: true });
    } finally {
      await mounted.unmount();
    }
  });

  it('waits while no machine is known, and drops the link when nothing is paired', async () => {
    const went: string[] = [];
    captureRuleDeepLink(hereAt(`#rules/${STAGE_ID}`));
    const waiting = await mount(<Probe machine={null} navigate={to => went.push(to)} paired />);
    try {
      expect(pendingRuleDeepLink()).not.toBeNull();
    } finally {
      await waiting.unmount();
    }
    const unpaired = await mount(<Probe machine={null} navigate={to => went.push(to)} paired={false} />);
    try {
      expect(pendingRuleDeepLink()).toBeNull();
      expect(went).toEqual([]);
    } finally {
      await unpaired.unmount();
    }
  });

  it('does nothing without a link', async () => {
    const went: string[] = [];
    const mounted = await mount(<Probe machine={here} navigate={to => went.push(to)} paired />);
    try {
      expect(went).toEqual([]);
    } finally {
      await mounted.unmount();
    }
  });
});

describe('the panel the link lands on', () => {
  const surface = (world: Parameters<typeof ruleClient>[0], asked: string[] = []) => {
    const fake = ruleClient(world);
    return {
      fake,
      element: (
        <SignInRulesSurface
          askPasskey={async stage => {
            asked.push(stage);
            return true;
          }}
          connection={connection}
          createClient={async () => fake.client}
          pollMs={60_000}
        />
      ),
    };
  };

  it('highlights and scrolls to the stage the daemon lists, and asks for no passkey', async () => {
    const asked: string[] = [];
    let scrolled = 0;
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = () => {
      scrolled += 1;
    };
    captureRuleDeepLink(hereAt(`#rules/${STAGE_ID}`));
    const { fake, element } = surface({ list: ruleList({ stages: [machineStage()] }) }, asked);
    const mounted = await mount(element);
    try {
      await settle();
      expect(q(mounted.container, `[data-rule-stage="${STAGE_ID}"]`).hasAttribute('data-highlighted')).toBe(true);
      expect(mounted.container.querySelector('[data-rule-linked-gone]')).toBeNull();
      expect(scrolled).toBeGreaterThan(0);
      expect(asked).toEqual([]);
      expect(fake.keys().some(key => key.includes('/bind') || key.includes('/commit'))).toBe(false);
      expect(pendingRuleDeepLink()).toBeNull();
    } finally {
      Element.prototype.scrollIntoView = original;
      await mounted.unmount();
    }
  });

  it('says it timed out or was answered when the list does not hold the stage', async () => {
    captureRuleDeepLink(hereAt(`#rules/${STAGE_ID}`));
    const { element } = surface({ list: ruleList({ stages: [] }) });
    const mounted = await mount(element);
    try {
      await settle();
      const gone = q(mounted.container, '[data-rule-linked-gone]');
      expect(gone.textContent).toBe(RULE_LINKED_STAGE_GONE_WORDS);
      expect(gone.getAttribute('role')).toBe('status');
      expect(mounted.container.querySelector('[data-highlighted]')).toBeNull();
      expect(pendingRuleDeepLink()).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('highlights nothing for a stage that is not the linked one, and spends the link on a refused device', async () => {
    captureRuleDeepLink(hereAt(`#rules/srs_${'d'.repeat(24)}`));
    const { element } = surface({ list: ruleList({ stages: [machineStage()] }) });
    const mounted = await mount(element);
    try {
      await settle();
      expect(mounted.container.querySelector('[data-highlighted]')).toBeNull();
      expect(q(mounted.container, '[data-rule-linked-gone]')).toBeTruthy();
    } finally {
      await mounted.unmount();
    }
    captureRuleDeepLink(hereAt(`#rules/${STAGE_ID}`));
    const refusing = surface({ fail: () => refused('forbidden', { status: 403 }) });
    const second = await mount(refusing.element);
    try {
      await settle();
      expect(second.container.querySelector('[data-rule-linked-gone]')).toBeNull();
      expect(pendingRuleDeepLink()).toBeNull();
    } finally {
      await second.unmount();
    }
  });
});
