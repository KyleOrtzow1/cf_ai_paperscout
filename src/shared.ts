// Approval string to be shared across frontend and backend
export const APPROVAL = {
  YES: "Yes, confirmed.",
  NO: "No, denied."
} as const;

// PaperScout agent state - synced to UI via Agent.setState
export type PaperScoutState = {
  preferences: {
    defaultMaxResults: number; // default 5
    recencyDays: number; // default 30
    categories: string[]; // default ["cs.AI", "cs.LG"]
  };
  libraryPreview: Array<{
    arxivId: string;
    title: string;
    savedAt: number;
    tags: string[];
  }>;
};
