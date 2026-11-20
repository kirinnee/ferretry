/**
 * The two pieces every Runtimes settings tab shares, so a group looks the same on every tab (r10 S11):
 *
 *   FleetGroup  one `SettingGroup` (a heading over hairline-divided rows, 32px before the next group) that also carries
 *               the tab's `data-setup-section` name, which a test and a deep link read
 *   Block       one list item of such a group for content that is not a `SettingRow`: a choice, a note, an apply panel.
 *               It lays out by the width of the PANEL it sits in (the Settings page is 212px wide in a 768px window),
 *               never by the window's.
 */

import { SettingGroup } from '@ferretry/app';
import type { ReactNode } from 'react';

export function FleetGroup({
  label,
  name,
  children,
}: {
  readonly label: string;
  readonly name: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="min-w-0" data-setup-section={name}>
      <SettingGroup label={label}>{children}</SettingGroup>
    </div>
  );
}

export function Block({ children, ...rest }: { readonly children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <li className="flex min-w-0 flex-col gap-2 px-panel py-3" {...rest}>
      {children}
    </li>
  );
}
