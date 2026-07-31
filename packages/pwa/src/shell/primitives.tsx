/**
 * The shared shadcn-shaped primitives every other shell component is built from.
 *
 * Ported from kteam `ui/src/components/Primitives.tsx`, silhouettes intact. The
 * load-bearing rule is that EVERY silhouette comes from a structural class
 * (`kt-btn`, `kt-panel`, `kt-input`, …) that reads role tokens from the theme
 * sheet. `data-variant` / `data-tone` carry ROLE and STATE only: a theme may
 * reshape a button into a 32px Neo block or a 26px Mission notched control, and
 * this file never learns which. There must never be a theme conditional here.
 *
 * Because these four are used by most of the app, changing them propagates the
 * design language for free — which is exactly why they are not allowed opinions.
 */

import type { ComponentPropsWithRef } from 'react';
import { cn } from '../lib/class-names.ts';

export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'danger';
export type ButtonSize = 'sm' | 'md';

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

export type BadgeTone = 'ok' | 'warn' | 'err' | 'pend' | 'accent';

export interface BadgeProps extends ComponentPropsWithRef<'span'> {
  readonly tone?: BadgeTone;
}

/**
 * The tone→colour map lives in `.kt-badge[data-tone=…]` so a theme can make
 * badges pills or hard-edged blocks without this component growing a geometry
 * opinion.
 */
export function Badge({ className, tone = 'pend', ...rest }: BadgeProps) {
  return <span data-tone={tone} className={cn('kt-badge', className)} {...rest} />;
}

/**
 * NOT `.kt-panel--clipped`: clipping is opt-in, because a clipped panel also
 * clips descendant popovers and focus rings.
 */
export function Card({ className, ...rest }: ComponentPropsWithRef<'div'>) {
  return <div className={cn('kt-panel', className)} {...rest} />;
}

/** Panel header row — the divider treatment is themed. */
export function PanelHeader({ className, ...rest }: ComponentPropsWithRef<'div'>) {
  return <div className={cn('kt-panel__header', className)} {...rest} />;
}

/** Panel body — owns the themed padding. Density is a design statement, not a preference. */
export function PanelBody({ className, ...rest }: ComponentPropsWithRef<'div'>) {
  return <div className={cn('kt-panel__body', className)} {...rest} />;
}

/**
 * `.kt-input` sizes its text from `--text-input`, which the theme sheet composes
 * as max(theme value, --input-font-floor). On a phone that can never resolve
 * below 16px, so iOS never focus-zooms and the viewport meta does not need
 * `maximum-scale` (which would break pinch-zoom, WCAG 1.4.4).
 *
 * No `focus:outline-none`: that pattern made the translucent ring the ONLY focus
 * indicator, measured at 1.5–2.9:1 across the theme families. `:focus-visible`
 * in the global sheet draws the real tokenised ring.
 */
export function Textarea({ className, ...rest }: ComponentPropsWithRef<'textarea'>) {
  return <textarea className={cn('kt-input', 'resize-y', className)} {...rest} />;
}

/** The shared quiet label for table headers, group headings and section titles. */
export function Label({ className, ...rest }: ComponentPropsWithRef<'span'>) {
  return <span className={cn('kt-label', className)} {...rest} />;
}

/** Button-group helper for header actions. */
export function ActionGroup({ className, ...rest }: ComponentPropsWithRef<'div'>) {
  return <div className={cn('flex flex-wrap items-center gap-sm', className)} {...rest} />;
}
