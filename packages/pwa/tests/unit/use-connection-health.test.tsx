import { describe, expect, it } from 'bun:test';
import type { ReactElement } from 'react';
import { useConnectionHealth } from '../../src/hooks/use-connection-health.ts';
import {
  type CarrierOutage,
  type ConnectionHealth,
  type ConnectionHealthEnvironment,
  DaemonConnectionHealth,
} from '../../src/lib/connection-health.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { interact, mount } from '../support/dom.ts';

const laptop = 'daemon-laptop' as DaemonId;
const workstation = 'daemon-workstation' as DaemonId;

const outage = (over: Partial<CarrierOutage> = {}): CarrierOutage => ({
  failures: [],
  daemonAbsent: false,
  relaysNeverOpened: false,
  ...over,
});

const quietEnvironment = (): ConnectionHealthEnvironment => ({
  now: () => 1_000,
  random: () => 0,
  isOnline: () => true,
  schedule: () => () => undefined,
});

const newHealth = (): DaemonConnectionHealth =>
  new DaemonConnectionHealth(quietEnvironment(), () => new Promise<unknown>(() => undefined));

const Probe = ({
  health,
  daemonId,
  renders,
}: {
  readonly health: ConnectionHealth;
  readonly daemonId: DaemonId;
  readonly renders?: string[];
}): ReactElement => {
  const state = useConnectionHealth(health, daemonId);
  const text =
    state.kind === 'reconnecting'
      ? `reconnecting:${state.attempt}:${state.failures.map(failure => failure.label).join(',')}:${state.stalled}`
      : state.kind;
  renders?.push(text);
  return <output>{text}</output>;
};

const text = (container: HTMLElement): string => container.querySelector('output')?.textContent ?? '';

describe('useConnectionHealth', () => {
  it('reads unknown before anything is measured', async () => {
    const health = newHealth();
    const { container, unmount } = await mount(<Probe health={health} daemonId={laptop} />);
    try {
      expect(text(container)).toBe('unknown');
    } finally {
      await unmount();
    }
  });

  it('re-renders as the daemon goes unknown, reconnecting, then connected', async () => {
    const health = newHealth();
    const { container, unmount } = await mount(<Probe health={health} daemonId={laptop} />);
    try {
      await interact(() => health.outage(laptop, outage({ failures: [{ label: 'Direct', detail: 'refused' }] })));
      expect(text(container)).toBe('reconnecting:0:Direct:false');
      await interact(() => health.retryNow(laptop));
      expect(text(container)).toBe('reconnecting:1:Direct:false');
      await interact(() => health.answered(laptop));
      expect(text(container)).toBe('connected');
      await interact(() => health.settled(laptop));
      expect(text(container)).toBe('unknown');
    } finally {
      await unmount();
    }
  });

  it('reads the state that already stood when it mounted', async () => {
    const health = newHealth();
    health.answered(laptop);
    const { container, unmount } = await mount(<Probe health={health} daemonId={laptop} />);
    try {
      expect(text(container)).toBe('connected');
    } finally {
      await unmount();
    }
  });

  it('ignores changes to another daemon', async () => {
    const health = newHealth();
    const renders: string[] = [];
    const { container, unmount } = await mount(<Probe health={health} daemonId={laptop} renders={renders} />);
    try {
      const before = renders.length;
      await interact(() => health.outage(workstation, outage()));
      expect(renders).toHaveLength(before);
      expect(text(container)).toBe('unknown');
    } finally {
      await unmount();
    }
  });

  it('follows the daemon id it is given', async () => {
    const health = newHealth();
    health.outage(workstation, outage({ failures: [{ label: 'Hosted relay', detail: 'closed' }] }));
    const { container, render, unmount } = await mount(<Probe health={health} daemonId={laptop} />);
    try {
      expect(text(container)).toBe('unknown');
      await render(<Probe health={health} daemonId={workstation} />);
      expect(text(container)).toBe('reconnecting:0:Hosted relay:false');
      await interact(() => health.answered(workstation));
      expect(text(container)).toBe('connected');
    } finally {
      await unmount();
    }
  });

  it('follows the health object it is given', async () => {
    const first = newHealth();
    const second = newHealth();
    second.answered(laptop);
    const { container, render, unmount } = await mount(<Probe health={first} daemonId={laptop} />);
    try {
      expect(text(container)).toBe('unknown');
      await render(<Probe health={second} daemonId={laptop} />);
      expect(text(container)).toBe('connected');
      await interact(() => first.outage(laptop, outage()));
      expect(text(container)).toBe('connected');
    } finally {
      await unmount();
    }
  });

  it('stops listening once it unmounts', async () => {
    const health = newHealth();
    const renders: string[] = [];
    const { unmount } = await mount(<Probe health={health} daemonId={laptop} renders={renders} />);
    try {
      await interact(() => health.outage(laptop, outage()));
    } finally {
      await unmount();
    }
    const after = renders.length;
    health.answered(laptop);
    expect(renders).toHaveLength(after);
  });
});
