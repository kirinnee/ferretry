import type { ComponentPropsWithRef } from 'react';
import { cn } from '../lib/class-names.ts';

type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'danger';
type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

export function Button({ className, variant = 'outline', size = 'md', ...rest }: ButtonProps) {
  return (
    <button
      // `outline` is the default and needs no data-variant: `.kt-btn`'s own
      // resting style IS the outline variant.
      data-variant={variant === 'outline' ? undefined : variant}
      className={cn('kt-btn', size === 'sm' && 'kt-btn--sm', className)}
      {...rest}
    />
  );
}
