/** The pull requests of the cards a nudge can name. */
export interface CardPullRequests {
  readonly id: string;
  readonly prs?: readonly { readonly number: number; readonly url: string }[];
}
