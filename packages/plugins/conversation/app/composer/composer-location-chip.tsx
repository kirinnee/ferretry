/**
 * The composer's pending-location chip, with the per-device "turn location back on" steps Access provides. They are
 * Access's device-permissions guide (its `access.how-to-enable-location` hook, read on this daemon); without Access the
 * chip keeps its generic steps.
 */

import { PendingLocationChip, useAppHook } from '@ferretry/app';
import { ACCESS_HOW_TO_ENABLE_LOCATION_HOOK, ACCESS_PROVIDED_APP_HOOKS } from '@ferretry/plugin-access/contract';
import type { ComponentProps } from 'react';

export function ComposerLocationChip({
  daemon,
  ...chip
}: ComponentProps<typeof PendingLocationChip> & { readonly daemon: string }) {
  const steps = useAppHook(daemon, ACCESS_HOW_TO_ENABLE_LOCATION_HOOK, 'access');
  const howToEnable = ACCESS_PROVIDED_APP_HOOKS[ACCESS_HOW_TO_ENABLE_LOCATION_HOOK](steps) ? steps : undefined;
  return <PendingLocationChip {...chip} {...(howToEnable === undefined ? {} : { howToEnable })} />;
}
