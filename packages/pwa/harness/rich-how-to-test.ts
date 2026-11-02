/** A long How to test as a ferret writes it: sub-headings, a label straight above a list that starts at 4, `code`, **bold** and →. */
export const RICH_HOW_TO_TEST = [
  'On your phone, once the Mac runs 4.157.0:',
  '',
  '## Pair the phone',
  '1. Open **Settings › Devices** and choose Pair a device.',
  '2. Run `fy pair` on the Mac → a six-digit code shows.',
  '3. Type the code on the phone → the device row appears.',
  '',
  '2FA codes',
  '4. Run `fy auth --totp` → **6 digits** show in the terminal.',
  '5. Enter them on the phone.',
  '6. The row says *Verified*.',
  '',
  '## Revoke it',
  '7. Open the device row and press **Revoke**.',
  '8. The phone is signed out → `fy devices` no longer lists it.',
].join('\n');

/** The run the harness pages share: `?rich=1` swaps a card's How to test for the long one above. */
export const richRequested = (): boolean => new URLSearchParams(window.location.search).get('rich') === '1';
