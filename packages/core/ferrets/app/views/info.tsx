/**
 * The `ferret.toolbar` panel `info`: the ⓘ that opens Info for the ferret the panel sits beside (the shell hands a
 * panel its `subject`, the ferret id). Info is a right panel on a desktop and a bottom sheet on a phone.
 */

import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { InfoToggle } from '../features/info/ferret-info.tsx';
import type { LiveFerretsClient } from '../lib/client.ts';
import '../features/info/info.css';
import '../features/restart-outdated/restart-outdated.css';

export function createInfoPanel(client: LiveFerretsClient): AppComponent<PanelProps> {
  return function InfoPanelView({ subject }: PanelProps) {
    if (subject === undefined) return null;
    return <InfoToggle client={client} ferretId={subject} key={subject} />;
  };
}
