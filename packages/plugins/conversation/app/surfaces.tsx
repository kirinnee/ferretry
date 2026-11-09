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
import type { ReactNode } from 'react';
import { ChatScreen } from './chat/chat-screen.tsx';
import { MessageMarksLegend } from './chat/message-marks-legend.tsx';
import { ChatWidthPanel } from './chat-width-control.tsx';
import { ConversationClientProvider } from './client.ts';
import { ComposerAttachPanel } from './composer/composer-attach.tsx';
import { ConversationSettings } from './composer/conversation-settings.tsx';
import { CompactAtPanel } from './compact-at/compact-at-panel.tsx';
import { LinksScreen } from './links/links-screen.tsx';
import { QuestionRenderer } from './questions/question-renderer.tsx';
import { QueuePanel } from './queue/queue-page.tsx';
import { AgendaConversationPanel } from './slots/agenda-conversation-panel.tsx';
import { FilesSearchPanel } from './slots/files-search-panel.tsx';
import { InterruptRowPanel } from './slots/interrupt-row-panel.tsx';
import { HypermediaPanel } from './toolbar/hypermedia-panel.tsx';

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
    readonly 'files-search': AppComponent<PanelProps>;
    readonly 'interrupt-row': AppComponent<PanelProps>;
    readonly 'agenda-conversation': AppComponent<PanelProps>;
  };
  readonly settings: { readonly conversation: AppComponent<SettingsProps> };
  readonly renderers: { readonly 'ask:question': AppComponent<RendererProps> };
}

/**
 * The `device.settings` panels (Settings › Appearance), drawn with NO daemon and NO client (shell contract S4): both read
 * and write only this device's controls, so they need none. They show with no machine paired, offline or locked.
 */
export const deviceSettingsPanels = {
  'chat-width': ChatWidthPanel,
  'message-marks': () => (
    <section>
      <h3>Message marks</h3>
      <MessageMarksLegend />
    </section>
  ),
} as const;

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
    'files-search': scoped<PanelProps>(client, FilesSearchPanel),
    'interrupt-row': scoped<PanelProps>(client, InterruptRowPanel),
    'agenda-conversation': scoped<PanelProps>(client, AgendaConversationPanel),
  },
  settings: { conversation: scoped<SettingsProps>(client, ConversationSettings) },
  renderers: { 'ask:question': scoped<RendererProps>(client, QuestionRenderer) },
});
