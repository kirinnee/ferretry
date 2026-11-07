/**
 * What a row in a ferret's Actions menu is, as far as the Warden's one row ("Ask the Warden to investigate now…")
 * needs it: the context the row is built from, the host its form opens in, and the form it offers. The menu is
 * Ferrets'; these are the shapes the row speaks to it in.
 */

import type { ReactNode } from 'react';
import type { FerretView } from './callsign.ts';

/** The context a ferret action runs in: the ferret, the name it is shown by and whether this device may control it. */
export interface CoreActionContext {
  readonly view: FerretView;
  readonly name: string;
  readonly canControl: boolean;
}

/** The host a ferret action's form opens in. */
export interface FerretActionFormHost {
  readonly close: () => void;
  readonly open: (actionId: string) => void;
  readonly notify: (sentence: string) => void;
  readonly compact: boolean;
}

/** What a ferret action row offers: a form, rendered in the host. */
export interface FerretActionForm {
  readonly kind: 'form';
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly icon: unknown;
  readonly render: (host: FerretActionFormHost) => ReactNode;
}

/** An action offered on a ferret, and the host its form opens in. */
export interface FerretActionContribution<Context = CoreActionContext> {
  readonly group: string;
  readonly order: number;
  readonly build: (context: Context) => FerretActionForm | null;
}
