/**
 * WHICH ACCOUNT NAMES A DAEMON-RAISED CARD CARRIES, anywhere in it (secrev-1261 L4, secrev-1329a L8): its title, subject,
 * why, context, how-to-resolve AND every structured ref. Agenda items are readable by every ferret and by a device the
 * grants deny `secrets.use`, so a card may name a place, never an account's label, its username or its handle (the
 * account id, often LABEL_USERNAME). Empty means the card is clean.
 */
export const namesOnCard = (card: unknown, names: readonly string[]): readonly string[] => {
  const text = JSON.stringify(card);
  return names.filter(name => text.includes(name));
};
