import type { ReactNode } from 'react';
import { config } from '@ferretry/kernel/host';
import type { ConfigFiles } from '../../../app/lib/pack-config.ts';
import { clockAt } from './timers.ts';

/**
 * What the app shell will offer a plugin half (`app/ui.ts`, PENDING.md), as the smallest honest stand-ins: the
 * same element names and data attributes the real primitives render, so a test reads the half's own markup.
 * A suite installs them with `mock.module('<path to app/ui.ts>', () => uiDoubles)` before importing the component.
 */
type Props = Record<string, unknown> & { readonly children?: ReactNode };

export const uiDoubles = {
  Badge: ({ tone, children, ...rest }: Props): ReactNode => (
    <span data-badge-tone={String(tone ?? 'neutral')} {...rest}>
      {children}
    </span>
  ),
  Button: ({ variant: _variant, children, ...rest }: Props): ReactNode => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
  RouteLink: ({ to, children, ...rest }: Props): ReactNode => (
    <a href={String(to)} {...rest}>
      {children}
    </a>
  ),
  Markdown: ({ text, className }: { text: string; className?: string }): ReactNode => (
    <div className={className}>
      {text
        .split(/(\*\*[^*]+\*\*)/u)
        .map(part => (part.startsWith('**') ? <strong key={part}>{part.slice(2, -2)}</strong> : part))}
    </div>
  ),
  PeerName: ({ peer }: { peer: { name: string; ferretId: string } }): ReactNode => (
    <a className="fy-peer-name" href={`/ferret/${peer.ferretId}`}>
      {peer.name}
    </a>
  ),
  MessageFooter: (): ReactNode => <span className="fy-message-footer" />,
  ToolGroup: (): ReactNode => <pre />,
  useReferenceSurface: () => ({}),
  cn: (...parts: readonly unknown[]): string => parts.filter(part => typeof part === 'string' && part !== '').join(' '),
  useShellClock: () => clockAt(Date.now()),
  useConfigFiles: (): ConfigFiles => ({
    text: {
      read: text => {
        const read = config.readConfigText(text);
        return read.ok ? { ok: true, value: read.read.value } : { ok: false };
      },
      edit: config.editConfigText,
    },
    read: async () => ({ text: '', etag: 'e1' }),
    write: async () => ({ outcome: 'applied' }),
  }),
};
