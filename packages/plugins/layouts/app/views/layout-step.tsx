/** The `layouts.layout` first-run step: the page, with this device's layout choice from the shell. */

import { useDeviceLayout, useDeviceViewport } from '@ferretry/app';
import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { LayoutStep } from '../features/onboarding/layout-step.tsx';

export function createLayoutStep(): AppComponent<PanelProps> {
  return function LayoutStepPanel(props: PanelProps) {
    const device = useDeviceLayout();
    const viewport = useDeviceViewport();
    return <LayoutStep step={props.step} device={device} viewport={viewport} />;
  };
}
