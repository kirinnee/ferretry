/**
 * The one badge for "this loosens what this machine may spend or do", on a setting in the key-by-key review and on
 * a held merge on Done. Two places saying the same thing in two wordings read as two different warnings, so both
 * draw this and neither words it again.
 */

import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '@ferretry/app';
import { Badge } from '@ferretry/app';

type BadgeData = { readonly [attribute: `data-${string}`]: string };

export function LoosensBadge({
  machineName,
  className,
  ...data
}: { readonly machineName: string } & Pick<ComponentPropsWithoutRef<'span'>, 'className'> & BadgeData) {
  return (
    <Badge tone="warn" className={cn('max-w-full !whitespace-normal', className)} {...data}>
      Loosens what {machineName} may spend or do
    </Badge>
  );
}
