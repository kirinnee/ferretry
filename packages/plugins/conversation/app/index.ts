import type {
  AppComponent,
  PanelProps,
  PluginClient,
  RendererProps,
  ScreenProps,
  SettingsProps,
} from '@ferretry/kernel/manifest';
import { provideToShell } from '@ferretry/app';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { CONVERSATION_ADD_TO_CHAT_HOOK } from '../contract/app-hooks.ts';
import { addToChatFor } from './composer/add-to-chat.ts';
import { documentDraftStore, documentRestoreStore } from './composer/drafts.ts';
import { lazyComponent } from './lazy.ts';
import { workSearchCommandSource } from './search/work-search-commands.ts';

type Surfaces = {
  readonly screens: Record<string, AppComponent<ScreenProps>>;
  readonly panels: Record<string, AppComponent<PanelProps>>;
  readonly settings: Record<string, AppComponent<SettingsProps>>;
  readonly renderers: Record<string, AppComponent<RendererProps>>;
};

/**
 * The view module (React), loaded on first use. The specifier is a Vite dynamic-import variable, which keeps this file
 * free of React so anything that only inspects the half (the registry generator, `manifest-match`) can load it.
 */
const loadSurfaces = (): Promise<Record<string, unknown>> => import(`./${'surfaces'}.tsx`);

/**
 * Conversation's app half: the chat and the links list as screens, the attachment entry, the queue and the compaction
 * setting as panels in the slots Ferrets' screen and the composer offer, the Conversation Settings tab and the renderer
 * for a ferret's question. Every surface reads through the one generated client and the client context (`client.ts`).
 * Bodies arrive by area: composer (`composer/`), chat and transcript (`chat/`, `transcript/`), queue, questions,
 * search and links (`queue/`, `questions/`, `search/`, `links/`); a surface whose body has not arrived draws one line.
 */
export default provideToShell(
  implementApp(manifest, {
    build: ({ client }) => {
      let surfaces: Promise<Surfaces> | undefined;
      const surfacesOf = (): Promise<Surfaces> => {
        surfaces ??= loadSurfaces().then(module =>
          (module.createSurfaces as (client: PluginClient) => Surfaces)(client),
        );
        return surfaces;
      };
      const screen = (id: 'chat' | 'links') =>
        lazyComponent<ScreenProps>(async () => (await surfacesOf()).screens[id] as AppComponent<ScreenProps>);
      const panel = (
        id:
          | 'attachments'
          | 'queue'
          | 'compact-at'
          | 'hypermedia'
          | 'chat-width'
          | 'files-search'
          | 'interrupt-row'
          | 'agenda-conversation',
      ) => lazyComponent<PanelProps>(async () => (await surfacesOf()).panels[id] as AppComponent<PanelProps>);
      return {
        screens: { chat: screen('chat'), links: screen('links') },
        panels: {
          attachments: panel('attachments'),
          queue: panel('queue'),
          'compact-at': panel('compact-at'),
          hypermedia: panel('hypermedia'),
          'chat-width': panel('chat-width'),
          'files-search': panel('files-search'),
          'interrupt-row': panel('interrupt-row'),
          'agenda-conversation': panel('agenda-conversation'),
        },
        settings: {
          conversation: lazyComponent<SettingsProps>(
            async () => (await surfacesOf()).settings.conversation as AppComponent<SettingsProps>,
          ),
        },
        renderers: {
          'ask:question': lazyComponent<RendererProps>(
            async () => (await surfacesOf()).renderers['ask:question'] as AppComponent<RendererProps>,
          ),
        },
      };
    },
  }),
  // Lead decision Q10: the shell's command bar lists the cards and asks the daemon's work search finds.
  {
    commands: context => workSearchCommandSource(context),
    // S15: the shared "Add to chat" any surface calls (Board's cards today), over this plugin's own daemon.
    hooks: { [CONVERSATION_ADD_TO_CHAT_HOOK]: ({ daemon }) => addToChatFor(daemon) },
    // S12: a later pairing that mints the same daemon id must not read this machine's unsent words back.
    forget: (daemon: string) => {
      documentDraftStore.clearDaemon(daemon);
      documentRestoreStore.clearDaemon(daemon);
    },
  },
);
