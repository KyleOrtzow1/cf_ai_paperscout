import type { ArxivPaper } from "./lib/arxiv";

// Approval string to be shared across frontend and backend
export const APPROVAL = {
  YES: "Yes, confirmed.",
  NO: "No, denied."
} as const;

// Library preview item - UI-oriented type for displaying saved papers
export interface LibraryPreviewItem {
  arxivId: string;
  title: string;
  savedAt: number;
  tags: string[];
}

// PaperScout agent state - synced to UI via Agent.setState
export type PaperScoutState = {
  preferences: {
    defaultMaxResults: number; // default 5
    recencyDays: number; // default 30
    categories: string[]; // default ["cs.AI", "cs.LG"]
  };
  libraryPreview: LibraryPreviewItem[];
};

/**
 * Convert an ArxivPaper to a LibraryPreviewItem for UI display.
 * This adapter keeps arXiv-isms out of UI code.
 *
 * @param paper - The arXiv paper data
 * @param tags - Tags to associate with the saved paper
 * @param savedAt - Timestamp when the paper was saved (defaults to now)
 * @returns UI-friendly library preview item
 */
export function toLibraryPreview(
  paper: ArxivPaper,
  tags: string[] = [],
  savedAt: number = Date.now()
): LibraryPreviewItem {
  return {
    arxivId: paper.arxivId,
    title: paper.title,
    savedAt,
    tags
  };
}
