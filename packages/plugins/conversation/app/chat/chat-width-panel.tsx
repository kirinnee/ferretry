/**
 * THIS DEVICE'S CONVERSATION WIDTH (`device.settings` › `chat-width`, lead decision Q11): today's Settings row, drawn
 * by the half that reads it. The choice is device-wide (`chatWidth` in this device's controls), so every chat on this
 * browser takes it at once.
 */

import { useDeviceControls } from '@ferretry/app';
import { ChatWidthControl } from './chat-width-control.tsx';

export function ChatWidthPanel() {
  const { device, set } = useDeviceControls();
  return <ChatWidthControl onChange={chatWidth => void set({ chatWidth })} value={device.chatWidth} />;
}
