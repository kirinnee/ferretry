/** Reading `--brief-file` is IO; the controller asks for the text and stays pure. */
export interface ITextFileReader {
  readText(path: string): Promise<string>;
}
