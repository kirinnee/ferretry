/**
 * A secret, by NAME, and whether the store holds it: "${secret:ZAI_API_KEY} set ✓" or "needs ZAI_API_KEY".
 *
 * Not a `Badge`: a theme may upper-case badges, and `${SECRET:ZAI_API_KEY}` is a reference that does
 * not exist — a secret name is case-sensitive, so it is shown exactly as it is written.
 */

import { Lock } from 'lucide-react';
import type { ComponentPropsWithRef } from 'react';
import { cn } from '../../../lib/class-names.ts';
import { secretRef } from './environment-model.ts';

export interface SecretPillProps extends ComponentPropsWithRef<'span'> {
  readonly name: string;
  readonly set: boolean;
}

export function SecretPill({ name, set, className, ...rest }: SecretPillProps) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 self-start break-all rounded-control px-2 py-0.5 font-mono text-meta font-medium',
        set ? 'bg-accent-soft text-ok' : 'bg-warn-soft text-warn',
        className,
      )}
      {...rest}
    >
      {set ? (
        <>
          <Lock size={12} aria-hidden="true" className="shrink-0" /> {secretRef(name)} set ✓
        </>
      ) : (
        `needs ${name}`
      )}
    </span>
  );
}
