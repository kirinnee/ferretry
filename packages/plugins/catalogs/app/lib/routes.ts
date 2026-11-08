/** The addresses Catalogs' screens live at: `sharing/:tab?` on a daemon, `/join` and `/shared` on none. */

import { daemonHomeHref } from '@ferretry/app';
import type { DaemonId } from './machine.ts';

export const SHARING_TABS = ['shared', 'catalogs', 'people'] as const;
export type SharingTab = (typeof SHARING_TABS)[number];

export const isSharingTab = (value: string | undefined): value is SharingTab =>
  value !== undefined && (SHARING_TABS as readonly string[]).includes(value);

export const JOIN_PATH = '/join';
export const SHARED_PATH = '/shared';

/** `/d/<daemon>/sharing[/<tab>]` */
export const daemonSharingPath = (id: DaemonId, tab?: SharingTab): string =>
  `${daemonHomeHref(id)}/sharing${tab === undefined ? '' : `/${tab}`}`;
