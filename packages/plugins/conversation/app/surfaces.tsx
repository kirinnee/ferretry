/**
 * EVERY SURFACE CONVERSATION DRAWS, built once per daemon from the generated client: the chat and links screens, the
 * attachments, queue and compact-at panels, the Conversation Settings tab and the question renderer.
 *
 * Each is wrapped in the client context ({@link ConversationClientProvider}) and loaded on first use. The bodies
 * arrive with the composer (C2), the chat and transcript (C3) and the queue, questions, search and links (C4); until a
 * body lands its slot draws ONE quiet line and never throws, so the shell and every other plugin keep working.
 */

import { skeletonSentence } from '@ferretry/kernel/contract';
import type {
  AppComponent,
  PanelProps,
  PluginClient,
  RendererProps,
  ScreenProps,
  SettingsProps,
} from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { ConversationClientProvider } from './client.ts';
import { ComposerAttachPanel } from './composer/composer-attach.tsx';
import { ConversationSettings } from './composer/conversation-settings.tsx';

const TITLE = 'Conversation';

/** The one line a surface shows until its body is brought over. */
const Pending = (): ReactNode => (
  <p className="fy-shell-line fy-shell-line--info" role="status">
    {skeletonSentence(TITLE)}
  </p>
);

/** A surface body inside the client context. */
const scoped =
  <Props,>(client: PluginClient, Body: (props: Props) => ReactNode): AppComponent<Props> =>
  props => (
    <ConversationClientProvider client={client}>
      <Body {...(props as Props & object)} />
    </ConversationClientProvider>
  );

export interface ConversationSurfaces {
  readonly screens: { readonly chat: AppComponent<ScreenProps>; readonly links: AppComponent<ScreenProps> };
  readonly panels: {
    readonly attachments: AppComponent<PanelProps>;
    readonly queue: AppComponent<PanelProps>;
    readonly 'compact-at': AppComponent<PanelProps>;
    readonly 'chat-width': AppComponent<PanelProps>;
  };
  readonly settings: { readonly conversation: AppComponent<SettingsProps> };
  readonly renderers: { readonly 'ask:question': AppComponent<RendererProps> };
}

export const createSurfaces = (client: PluginClient): ConversationSurfaces => ({
  screens: {
    chat: scoped<ScreenProps>(client, Pending),
    links: scoped<ScreenProps>(client, Pending),
  },
  panels: {
    attachments: scoped<PanelProps>(client, ComposerAttachPanel),
    queue: scoped<PanelProps>(client, Pending),
    'compact-at': scoped<PanelProps>(client, Pending),
    'chat-width': scoped<PanelProps>(client, Pending),
  },
  settings: { conversation: scoped<SettingsProps>(client, ConversationSettings) },
  renderers: { 'ask:question': scoped<RendererProps>(client, Pending) },
});
