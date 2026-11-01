/**
 * "More": the quiet menu for the ways of adding a catalog that are not a link. Today that is one thing,
 * "Install from a file…", which stays for swapping a catalog without a network.
 */

import { FileUp, MoreHorizontal } from 'lucide-react';
import { useRef, useState } from 'react';
import { ContextMenu, type MenuAnchor } from '../../shell/context-menu.tsx';
import { Button } from '../../shell/primitives.tsx';

const MORE_LABEL = 'More';
const INSTALL_FROM_FILE_LABEL = 'Install from a file…';
const INSTALL_FROM_FILE_HINT = 'For a catalog file you were handed. It works offline.';

interface CatalogMoreMenuProps {
  readonly onInstallFromFile: () => void;
  readonly size?: 'sm' | 'md';
}

export function CatalogMoreMenu({ onInstallFromFile, size = 'sm' }: CatalogMoreMenuProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);

  const openMenu = (): void => {
    const rect = triggerRef.current?.getBoundingClientRect();
    setAnchor({ x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4 });
  };

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        size={size}
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={openMenu}
        data-catalog-more=""
      >
        <MoreHorizontal size={16} aria-hidden="true" />
        {MORE_LABEL}
      </Button>
      <ContextMenu
        open={anchor !== null}
        anchor={anchor ?? { x: 0, y: 0 }}
        ariaLabel="More ways to add a catalog"
        triggerRef={triggerRef}
        onClose={() => setAnchor(null)}
        items={[
          {
            key: 'install-from-file',
            label: INSTALL_FROM_FILE_LABEL,
            hint: INSTALL_FROM_FILE_HINT,
            icon: <FileUp size={16} aria-hidden="true" />,
            onSelect: onInstallFromFile,
          },
        ]}
      />
    </>
  );
}
