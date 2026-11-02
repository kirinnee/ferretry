/** `<app>/#rules/<stage>` (printed by `fy rules add`): routed to a machine's Secure copy panel, highlighted only if listed, never a passkey ask. */

import { afterEach, describe, expect, it } from 'bun:test';
import { type DaemonId, ruleDeepLinkFragment } from '@ferretry/protocol';
import { SignInRulesSurface } from '../../../src/features/secure-copy/sign-in-rules-surface.tsx';
import { type RuleLinkMachine, useRuleDeepLink } from '../../../src/hooks/use-rule-deep-link.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import {
  captureRuleDeepLink,
  clearRuleDeepLink,
  markRuleDeepLinkRouted,
  pendingRuleDeepLink,
  listenForRuleDeepLinks,
  subscribeRuleDeepLink,
} from '../../../src/lib/rule-deep-link.ts';
import { RULE_LINKED_STAGE_GONE_WORDS } from '../../../src/lib/sign-in-rules.ts';
import { mount, must } from '../../support/dom.ts';
import { settle } from '../../support/dom-form.ts';
import { refused, ruleClient } from '../../support/sign-in-rule-client.ts';
import { machineStage, ruleList, STAGE_ID } from '../../support/sign-in-rule-fixtures.ts';

const hereAt = (hash: string) => ({ hash, pathname: '/app/', search: '?x=1' });
const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example', deviceId: 'phone-1' });
const daemon = (letter: string): DaemonId => `fy_daemon_${letter.repeat(43)}` as DaemonId;
const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);

afterEach(() => clearRuleDeepLink());

describe('reading the fragment', () => {
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

  it('keeps the machine the link names', () => {
    captureRuleDeepLink(hereAt(ruleDeepLinkFragment(STAGE_ID, daemon('s'))));
    expect(pendingRuleDeepLink()).toEqual({ stage: STAGE_ID, machine: daemon('s'), routed: false });
  });

  it('ignores an invalid stage id, leaving the address alone', () => {
    captureRuleDeepLink(hereAt('#rules/bogus'));
    expect(pendingRuleDeepLink()).toBeNull();
    markRuleDeepLinkRouted();
    expect(pendingRuleDeepLink()).toBeNull();
  });

  it('reads a link followed while the app is already open, and stops listening when asked', () => {
    const target = new EventTarget() as unknown as Window;
    Object.defineProperty(target, 'location', { value: hereAt(`#rules/${STAGE_ID}`) });
    const stop = listenForRuleDeepLinks(target);
    target.dispatchEvent(new Event('hashchange'));
    expect(pendingRuleDeepLink()).toEqual({ stage: STAGE_ID, routed: false });
    clearRuleDeepLink();
    stop();
    target.dispatchEvent(new Event('hashchange'));
    expect(pendingRuleDeepLink()).toBeNull();
  });
});

describe('routing the link', () => {
  function Probe({
    machines,
    selected,
    navigate,
    elsewhere = () => undefined,
  }: {
    readonly machines: readonly RuleLinkMachine[];
    readonly selected?: DaemonId;
    readonly navigate: (to: string) => void;
    readonly elsewhere?: (machine: DaemonId) => void;
  }) {
    useRuleDeepLink(machines, selected, navigate, elsewhere);
    return null;
  }
  const studio: RuleLinkMachine = {
    daemonId: daemon('s'),
    secureCopyPath: '/m/studio/settings#machine-secure-copy',
  };
  const laptop: RuleLinkMachine = {
    daemonId: daemon('l'),
    secureCopyPath: '/m/laptop/settings#machine-secure-copy',
  };

  it('goes to the selected machine’s Secure copy panel once, keeping the stage for the panel', async () => {
    const went: string[] = [];
    captureRuleDeepLink(hereAt(`#rules/${STAGE_ID}`));
    const mounted = await mount(
      <Probe machines={[studio, laptop]} navigate={to => went.push(to)} selected={laptop.daemonId} />,
    );
    try {
      expect(went).toEqual([laptop.secureCopyPath]);
      expect(pendingRuleDeepLink()).toEqual({ stage: STAGE_ID, routed: true });
    } finally {
      await mounted.unmount();
    }
  });

  it('opens on the machine the link names, not the selected one', async () => {
    const went: string[] = [];
    captureRuleDeepLink(hereAt(ruleDeepLinkFragment(STAGE_ID, laptop.daemonId)));
    const mounted = await mount(
      <Probe machines={[studio, laptop]} navigate={to => went.push(to)} selected={studio.daemonId} />,
    );
    try {
      expect(went).toEqual([laptop.secureCopyPath]);
    } finally {
      await mounted.unmount();
    }
  });

  it('says so, and goes nowhere, when the link names a machine this device is not paired with', async () => {
    const went: string[] = [];
    const told: string[] = [];
    captureRuleDeepLink(hereAt(ruleDeepLinkFragment(STAGE_ID, daemon('e'))));
    const mounted = await mount(
      <Probe elsewhere={machine => told.push(machine)} machines={[studio]} navigate={to => went.push(to)} />,
    );
    try {
      expect(went).toEqual([]);
      expect(told).toEqual([daemon('e')]);
      expect(pendingRuleDeepLink()).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('drops the link when nothing is paired', async () => {
    const went: string[] = [];
    captureRuleDeepLink(hereAt(`#rules/${STAGE_ID}`));
    const mounted = await mount(<Probe machines={[]} navigate={to => went.push(to)} />);
    try {
      expect(pendingRuleDeepLink()).toBeNull();
      expect(went).toEqual([]);
    } finally {
      await mounted.unmount();
    }
  });

  it('does nothing without a link', async () => {
    const went: string[] = [];
    const mounted = await mount(<Probe machines={[studio]} navigate={to => went.push(to)} />);
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
