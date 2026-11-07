/**
 * EVERY SURFACE CONVERSATION DRAWS, built once per daemon from the generated client: the chat and links screens, the
 * attachments, queue, compact-at, hypermedia and chat-width panels, the Conversation Settings tab and the question
 * renderer.
 *
 * Each is wrapped in the client context ({@link ConversationClientProvider}) and loaded on first use.
 */

import type {
  AppComponent,
  PanelProps,
  PluginClient,
  RendererProps,
  ScreenProps,
  SettingsProps,
} from '@ferretry/kernel/manifest';
import { skeletonSentence } from '@ferretry/kernel/contract';
import type { ReactNode } from 'react';
import { ChatScreen } from './chat/chat-screen.tsx';
import { ConversationClientProvider } from './client.ts';
import { ComposerAttachPanel } from './composer/composer-attach.tsx';
import { ConversationSettings } from './composer/conversation-settings.tsx';
import { CompactAtPanel } from './compact-at/compact-at-panel.tsx';
import { LinksScreen } from './links/links-screen.tsx';
import { QuestionRenderer } from './questions/question-renderer.tsx';
import { QueuePanel } from './queue/queue-page.tsx';
import { HypermediaPanel } from './toolbar/hypermedia-panel.tsx';

const TITLE = 'Conversation';

/** The `chat-width` panel until its porter (C2, lead ruling Q11) lands ChatWidthControl. */
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
    readonly hypermedia: AppComponent<PanelProps>;
    readonly 'chat-width': AppComponent<PanelProps>;
  };
  readonly settings: { readonly conversation: AppComponent<SettingsProps> };
  readonly renderers: { readonly 'ask:question': AppComponent<RendererProps> };
}

export const createSurfaces = (client: PluginClient): ConversationSurfaces => ({
  screens: {
    chat: scoped<ScreenProps>(client, ChatScreen),
    links: scoped<ScreenProps>(client, () => <LinksScreen />),
  },
  panels: {
    attachments: scoped<PanelProps>(client, ComposerAttachPanel),
    queue: scoped<PanelProps>(client, QueuePanel),
    'compact-at': scoped<PanelProps>(client, CompactAtPanel),
    hypermedia: scoped<PanelProps>(client, HypermediaPanel),
    'chat-width': scoped<PanelProps>(client, Pending),
  },
  settings: { conversation: scoped<SettingsProps>(client, ConversationSettings) },
  renderers: { 'ask:question': scoped<RendererProps>(client, QuestionRenderer) },
});
