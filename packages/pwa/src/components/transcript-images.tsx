/**
 * The pictures a transcript row carries: a screenshot a person pasted, an image a ferret shared, a
 * screenshot a tool returned. It is the attachment gallery's own thumbnails and full-screen viewer over
 * `transcript` images, so lazy loading, the shared blob cache, pinch zoom and swiping are one
 * implementation. This file only knows which daemon and session the row is in (from the hand-off
 * source) and what each picture should be called.
 */

import type { TranscriptImageMarker } from '@ferretry/protocol';
import { formatTranscriptImageHandle } from '@ferretry/protocol';
import { useMemo } from 'react';
import type { TranscriptImage } from '../lib/attachments.ts';
import { TranscriptAttachmentGallery } from './attachment-gallery.tsx';
import { useHandoffSource } from './handoff-message.tsx';

/** One picture and what it is called for a reader who cannot see it. */
export interface NamedTranscriptImage {
  readonly marker: TranscriptImageMarker;
  readonly alt: string;
}

/** The alt text of a picture a person shared: theirs, or a ferret's under its own name. */
export const messageImageAlt = (role: 'user' | 'assistant', agentName: string | undefined): string => {
  if (role === 'user') return 'Image you shared';
  return agentName === undefined || agentName === '' || agentName === 'Assistant'
    ? 'Image the ferret shared'
    : `Image from ${agentName}`;
};

/** The alt text of a picture a tool returned: `mcp__playwright__browser_take_screenshot` is "Screenshot from playwright". */
export const toolImageAlt = (toolName: string | undefined): string => {
  const name = toolName === undefined || toolName === '' ? 'a tool' : toolName;
  const parts = name.split('__');
  const label = parts[0] === 'mcp' && parts.length >= 3 && parts[1] !== '' ? (parts[1] as string) : name;
  return /screenshot/iu.test(name) ? `Screenshot from ${label}` : `Image from ${label}`;
};

export interface TranscriptImagesProps {
  readonly images: readonly NamedTranscriptImage[];
  /** More than this many show behind a "Show N more" control. Absent: all of them. */
  readonly initialLimit?: number;
  readonly className?: string;
}

/**
 * Outside a session workspace there is no daemon to read from, so nothing is drawn: the row keeps
 * whatever text it has and a picture it cannot fetch is simply not claimed.
 */
export function TranscriptImages({ images, initialLimit, className }: TranscriptImagesProps) {
  const source = useHandoffSource();
  const sessionId = source?.sessionId;
  const stored = useMemo(
    () =>
      sessionId === undefined
        ? []
        : images.map(
            ({ marker, alt }): TranscriptImage => ({
              kind: 'transcript',
              sessionId,
              handle: formatTranscriptImageHandle(marker.handle),
              ...(marker.mediaType === undefined ? {} : { mediaType: marker.mediaType }),
              alt,
            }),
          ),
    [images, sessionId],
  );
  if (source === null || stored.length === 0) return null;
  return (
    <TranscriptAttachmentGallery
      className={className ?? 'fy-transcript-images'}
      daemon={source.daemon}
      images={stored}
      {...(initialLimit === undefined ? {} : { initialLimit })}
    />
  );
}
