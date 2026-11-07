/**
 * The addresses of the screens the Warden's pages link to, as the shell's route table spells them for a daemon
 * (`/d/<daemon>/…`): the Agenda and a ferret's chat. A page drawn without a shell has none, so a test that follows
 * one of these links draws inside this provider.
 */

import { ScreenHrefProvider } from '@ferretry/app';
import type { ReactNode } from 'react';

const href = (
  daemon: string,
  plugin: string,
  screen: string,
  params: Readonly<Record<string, string>> = {},
): string | undefined => {
  const base = `/d/${encodeURIComponent(daemon)}`;
  if (plugin === 'agenda' && screen === 'agenda') return `${base}/agenda`;
  if (plugin === 'conversation' && screen === 'chat' && params.ferret !== undefined)
    return `${base}/ferrets/${encodeURIComponent(params.ferret)}/chat`;
  return undefined;
};

export function Screens({ children }: { readonly children?: ReactNode }) {
  return <ScreenHrefProvider href={href}>{children}</ScreenHrefProvider>;
}
