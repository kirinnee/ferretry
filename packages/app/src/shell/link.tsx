import type { MouseEvent } from 'react';
import { useRouter } from '../router/router.tsx';

/** An in-app link: a plain click navigates in place; a modifier or middle click is the browser's (a new tab). */
export function Link({
  to,
  children,
  className,
  current,
  title,
}: {
  readonly to: string;
  readonly children: React.ReactNode;
  readonly className?: string;
  /** The page this link names is the one on screen (`aria-current="page"`). */
  readonly current?: boolean;
  /** The tooltip, for a link that draws an icon alone. */
  readonly title?: string;
}) {
  const router = useRouter();
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    router.navigate(to);
  };
  return (
    <a
      href={to}
      onClick={onClick}
      className={className}
      title={title}
      aria-current={current === true ? 'page' : undefined}
    >
      {children}
    </a>
  );
}
