/**
 * WHERE THE ADD RUNTIME PAGE ADDS A LOGIN AND SIGNS ONE IN: the two slots it offers (contract/slots.ts), mounted under
 * the login list and under a picked login that needs sign-in. Logins contributes the panels; Runtimes draws none of
 * them, and hands them only a callback — a login's id, or a bare "signed in". Where no panel is placed (a daemon whose
 * Logins panels are off, or a page outside the shell) each slot falls back to the link to Logins' Sign-ins tab, which
 * was this page's only way before the slots existed.
 */

import { PanelSlot, useSlotHasPanels } from '@ferretry/app';
import { ChevronRight, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { ADD_RUNTIME_LOGIN_SLOT, ADD_RUNTIME_SIGN_IN_SLOT } from '../../../../contract/index.ts';
import type { HarnessKind } from '../../../lib/logins-view.ts';
import { currentDaemon, followInApp, tabHref } from '../shell/machine-route.ts';

/** The link to Logins' Sign-ins tab, landing on one login when it names one. */
function SignInsLink({
  machineName,
  login,
  children,
  className,
  data,
}: {
  readonly machineName: string;
  readonly login?: string;
  readonly children: ReactNode;
  readonly className: string;
  readonly data: Record<string, string>;
}) {
  return (
    <a
      href={tabHref(currentDaemon(), machineName, 'sign-ins', login)}
      onClick={followInApp}
      className={className}
      {...data}
    >
      {children}
    </a>
  );
}

/** "+ Add a new login": opens Logins' add-login panel right under the list, or links to Sign-ins without one. */
export function AddLoginSlot({
  machineName,
  open,
  onOpenChange,
  onAdded,
}: {
  readonly machineName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The new login's id: the page re-reads the machine and picks it. */
  readonly onAdded: (id: string) => void;
}) {
  const daemon = currentDaemon();
  const placed = useSlotHasPanels(ADD_RUNTIME_LOGIN_SLOT);
  if (daemon === null || !placed)
    return (
      <SignInsLink
        machineName={machineName}
        className="kt-panel flex min-h-control w-full min-w-0 items-center gap-3 p-panel text-left text-row font-semibold text-fg no-underline hover:border-accent hover:no-underline"
        data={{ 'data-add-row': 'login' }}
      >
        <Plus size={16} aria-hidden="true" className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1">Add a new login in Sign-ins</span>
        <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted" />
      </SignInsLink>
    );
  return (
    <div className="flex min-w-0 flex-col gap-2" data-add-runtime-new-login={open ? 'open' : 'closed'}>
      <button
        type="button"
        data-add-row="login"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="kt-panel flex min-h-control w-full min-w-0 cursor-pointer items-center gap-3 p-panel text-left text-row font-semibold text-fg hover:border-accent"
      >
        <Plus size={16} aria-hidden="true" className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1">{open ? 'Cancel adding a login' : 'Add a new login'}</span>
      </button>
      {open ? <PanelSlot daemon={daemon} slot={ADD_RUNTIME_LOGIN_SLOT} props={{ onAdded }} /> : null}
    </div>
  );
}

/** A picked login that needs sign-in: Logins' sign-in panel for it, or the link to that login on Sign-ins. */
export function SignInSlot({
  machineName,
  login,
  harness,
  onSignedIn,
}: {
  readonly machineName: string;
  readonly login: string;
  readonly harness: HarnessKind;
  readonly onSignedIn: () => void;
}) {
  const daemon = currentDaemon();
  const placed = useSlotHasPanels(ADD_RUNTIME_SIGN_IN_SLOT);
  if (daemon === null || !placed)
    return (
      <SignInsLink
        machineName={machineName}
        login={login}
        className="font-semibold text-accent underline"
        data={{ 'data-add-runtime-sign-in': '' }}
      >
        Sign in
      </SignInsLink>
    );
  return (
    <div className="mt-2" data-add-runtime-sign-in-panel={login}>
      <PanelSlot daemon={daemon} slot={ADD_RUNTIME_SIGN_IN_SLOT} subject={login} props={{ harness, onSignedIn }} />
    </div>
  );
}
