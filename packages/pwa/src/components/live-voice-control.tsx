/**
 * LIVE VOICE FOR A COMPOSER: the Live button that sits next to the mic and the bar that takes the
 * composer's place while Live is on, as one hook returning both nodes (the shape `dictation-control.tsx`
 * uses), so the composer drops each where its layout wants it.
 *
 * It offers nothing to a device that may not send (`disabled`), to a page with no session to watch, or
 * with dictation switched off: those get no button at all. While Live is on the mic is held back by the
 * host (`onActiveChange`), and while the mic is recording Live is held back (`busyElsewhere`): one
 * microphone, one owner.
 *
 * Starting runs inside the tap (or the command-palette keypress): the microphone prompt belongs to the
 * gesture, so `start()` is called straight from the handler.
 */

import { type ReactNode, useEffect } from 'react';
import { useEffectiveDictation } from '../hooks/use-effective-dictation.ts';
import { extractHeldMessages, hasUsableContext } from '../hooks/use-dictation.ts';
import { type LiveVoiceHandle, type UseLiveVoiceOptions, useLiveVoice } from '../hooks/use-live-voice.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DeviceClass } from '../lib/stt/engine-defaults.ts';
import type { SttSettings } from '../lib/stt/stt-settings.ts';
import type { LiveComposerBridge } from '../lib/voice-chat/live-assembly.ts';
import { onLiveToggle } from '../lib/voice-chat/live-command.ts';
import type { LiveReadingSource } from '../lib/voice-chat/live-reader.ts';
import type { ReplySource } from '../lib/voice-chat/reply-feed.ts';
import { DEFAULT_STT_SETTINGS } from '../lib/stt/stt-settings.ts';
import { LiveVoiceBar } from './live-voice-bar.tsx';
import { LiveVoiceButton } from './live-voice-button.tsx';

export interface LiveVoiceControlProps {
  /** The device's dictation settings; Live needs them on. */
  readonly settings: SttSettings | undefined;
  /** The composer may not send (no rights, a finished session): no Live. */
  readonly disabled: boolean;
  readonly daemon: DaemonConnection;
  readonly bridge: LiveComposerBridge;
  readonly draft: string;
  /** The session's turn state; without one there is nothing to wait for. */
  readonly reply: ReplySource | undefined;
  readonly readConversation?: () => readonly string[];
  /** The conversation on screen, for reading the ferret's reply (and its questions) aloud. Absent: nothing is read. */
  readonly reading?: LiveReadingSource;
  /** Phone chrome: the big-button bar. Otherwise the desktop strip. */
  readonly compact: boolean;
  /** The mic is recording: Live waits. */
  readonly busyElsewhere: boolean;
  readonly deviceClass?: DeviceClass;
  onActiveChange?(active: boolean): void;
  /** Where the command palette's request arrives; the page's document when omitted. */
  readonly commandTarget?: Parameters<typeof onLiveToggle>[0] | null;
  /** The shortcut shown in the button's tooltip. */
  readonly shortcutHint?: string;
  // Seams for tests and the visual harness.
  readonly seams?: Pick<
    UseLiveVoiceOptions,
    'recognition' | 'meter' | 'enhancementFetch' | 'voice' | 'speedupKeys' | 'ports' | 'graceMs' | 'pauseMs'
  >;
}

const NO_SETTINGS = { ...DEFAULT_STT_SETTINGS, enabled: false };

export interface LiveVoiceControl {
  /** The Live button, or null where Live is not offered. */
  readonly button: ReactNode;
  /** The bar above the composer; null while Live is off and says nothing. */
  readonly bar: ReactNode;
  readonly live: LiveVoiceHandle;
}

export function useLiveVoiceControl(props: LiveVoiceControlProps): LiveVoiceControl {
  const offered = props.settings?.enabled === true && props.reply !== undefined && !props.disabled;
  const { settings, voiceCleanup } = useEffectiveDictation({
    deviceSettings: props.settings ?? NO_SETTINGS,
    daemon: props.daemon,
    deviceClass: props.deviceClass,
    skip: !offered,
  });
  const readConversation = props.readConversation;
  const reading = props.reading;
  const live = useLiveVoice({
    enabled: offered,
    daemon: props.daemon,
    settings,
    voiceCleanup,
    composer: props.bridge,
    draft: props.draft,
    reply: props.reply ?? NO_REPLY,
    ...(readConversation === undefined ? {} : { readConversation }),
    ...(reading === undefined ? {} : { reading }),
    readContext: needsEvidence => {
      const held = extractHeldMessages(readConversation?.() ?? []);
      return !needsEvidence || hasUsableContext(held) ? held : [];
    },
    ...props.seams,
  });

  const { onActiveChange } = props;
  useEffect(() => {
    onActiveChange?.(live.active);
  }, [live.active, onActiveChange]);

  // The command palette's "Live voice" toggles the same Live the button does.
  const { start, end, active } = live;
  const target =
    props.commandTarget === undefined ? (typeof document === 'undefined' ? null : document) : props.commandTarget;
  useEffect(() => {
    if (!offered || target === null || props.busyElsewhere) return;
    return onLiveToggle(target, () => (active ? end() : start()));
  }, [offered, target, props.busyElsewhere, active, start, end]);

  const button = offered ? (
    <LiveVoiceButton
      // Icon-only on both layouts: the word does not fit a narrow agent pane beside another pane (the geometry
      // harness found a 19px sideways overflow at 1100px), and the Live bar carries the word once Live is on.
      layout="compact"
      active={live.active}
      disabled={props.busyElsewhere}
      onPress={live.active ? live.end : live.start}
      {...(props.shortcutHint === undefined ? {} : { shortcutHint: props.shortcutHint })}
    />
  ) : null;

  const bar = live.view.visible ? (
    <LiveVoiceBar
      view={live.view}
      layout={props.compact ? 'phone' : 'desktop'}
      levels={live.levels}
      onHold={live.hold}
      onSendNow={live.sendNow}
      onResume={live.resume}
      onEnd={live.end}
      onSkip={live.skip}
      onRepeat={live.repeat}
    />
  ) : null;

  return { button, bar, live };
}

const NO_REPLY: ReplySource = { current: () => null, subscribe: () => () => undefined };
