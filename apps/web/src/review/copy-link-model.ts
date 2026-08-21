export interface CopyLinkActionData {
  readonly getLink: () => string;
  readonly writeText: (link: string) => Promise<void>;
  readonly disabled?: boolean;
}

export interface PdfDestinationCopyLink extends CopyLinkActionData {
  readonly precision: 'exact' | 'page';
}
