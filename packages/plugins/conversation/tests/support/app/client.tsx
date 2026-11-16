/**
 * The client context the half's surfaces give a view, for the app tests (the fake client itself is `fake-client.ts`).
 * `withClient` wraps a view in that context and in a screen-address table.
 */

import { ScreenHrefProvider } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ReactElement, ReactNode } from 'react';
import { ConversationClientProvider } from '../../../app/client.ts';

/** Every screen address a suite's views ask for, spelled `/<daemon>/<plugin>/<screen>?<params>`. */
export const testHref = (
  daemon: string,
  plugin: string,
  screen: string,
  params: Readonly<Record<string, string>> = {},
) =>
  `/${daemon}/${plugin}/${screen}${Object.keys(params).length === 0 ? '' : `?${new URLSearchParams(params).toString()}`}`;

/** A view inside the client context (and a screen-address table), as a surface draws it. */
export const withClient = (client: PluginClient, view: ReactNode): ReactElement => (
  <ScreenHrefProvider href={testHref}>
    <ConversationClientProvider client={client}>{view}</ConversationClientProvider>
  </ScreenHrefProvider>
);
