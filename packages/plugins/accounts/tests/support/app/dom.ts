/** The shell's DOM harness (`@ferretry/app/testing`), with a document registered. A test imports this, not `react-dom/client`. */
import { ensureDom, interact, type Mounted, mount, must, pressKey } from '@ferretry/app/testing';

ensureDom();

export { interact, type Mounted, mount, must, pressKey };
