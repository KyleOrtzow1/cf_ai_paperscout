import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/button/Button";
import { Card } from "@/components/card/Card";
import type { LibraryPreviewItem } from "@/shared";
import {
  XIcon,
  BookOpenIcon,
  TrashIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretRightIcon,
  BookmarksIcon
} from "@phosphor-icons/react";

interface LibraryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  papers: LibraryPreviewItem[];
  onSendMessage: (message: string) => Promise<void>;
}

export const LibraryPanel = ({
  isOpen,
  onClose,
  papers,
  onSendMessage
}: LibraryPanelProps) => {
  const [expandedPapers, setExpandedPapers] = useState<Set<string>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);


  // Focus trap and keyboard navigation
  useEffect(() => {
    if (!isOpen || !panelRef.current) return;

    const focusableElements = panelRef.current.querySelectorAll(
      'a, button, input, textarea, select, details, [tabindex]:not([tabindex="-1"])'
    ) as NodeListOf<HTMLElement>;

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (firstElement) firstElement.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        if (e.shiftKey) {
          // Shift + Tab moves focus backward
          if (
            firstElement &&
            lastElement &&
            document.activeElement === firstElement
          ) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          // Tab moves focus forward
          if (
            firstElement &&
            lastElement &&
            document.activeElement === lastElement
          ) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
      if (e.key === "Escape") {
        onCloseRef.current();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  const toggleExpand = (arxivId: string) => {
    setExpandedPapers((prev) => {
      const next = new Set(prev);
      if (next.has(arxivId)) {
        next.delete(arxivId);
      } else {
        next.add(arxivId);
      }
      return next;
    });
  };

  const handleSummarize = async (arxivId: string) => {
    try {
      await onSendMessage(`Summarize paper ${arxivId}`);
      // Optionally close panel after action
      // onClose();
    } catch (error) {
      console.error("Failed to request summary:", error);
    }
  };

  const handleRemove = async (arxivId: string) => {
    try {
      await onSendMessage(`Remove paper ${arxivId} from my library`);
    } catch (error) {
      console.error("Failed to remove paper:", error);
    }
  };

  const handleView = (arxivId: string) => {
    window.open(
      `https://arxiv.org/abs/${arxivId}`,
      "_blank",
      "noopener,noreferrer"
    );
  };

  return (
    <div
      ref={panelRef}
      className={`
        w-[320px] border-r-2 border-ob-border
        bg-ob-base-100 flex flex-col
        fixed inset-y-0 left-0 z-50 transition-transform duration-300
        ${isOpen ? "translate-x-0" : "-translate-x-full"}
      `}
      tabIndex={-1}
    >
        {/* Header */}
        <div className="px-4 h-[60px] border-b-2 border-ob-border bg-ob-base-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookmarksIcon size={20} className="text-[#F48120]" />
            <h2 className="font-semibold text-base font-serif">Library</h2>
          </div>
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            onClick={onClose}
            aria-label="Close library panel"
          >
            <XIcon size={16} />
          </Button>
        </div>

        {/* Paper list or empty state */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {papers.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-sm text-ob-base-100 text-center font-sans">
                No Saved Papers
              </p>
            </div>
          ) : (
            papers.map((paper) => {
              const isExpanded = expandedPapers.has(paper.arxivId);
              const shouldTruncate = paper.title.length > 80;
              const displayTitle =
                isExpanded || !shouldTruncate
                  ? paper.title
                  : `${paper.title.slice(0, 80)}...`;

              return (
                <Card
                  key={paper.arxivId}
                  className="p-0 overflow-hidden border-l-[3px] border-l-accent-academic"
                >
                  {/* Paper Header - Always visible */}
                  <button
                    onClick={() =>
                      shouldTruncate && toggleExpand(paper.arxivId)
                    }
                    className={`w-full p-3 text-left flex items-start gap-2 ${
                      shouldTruncate
                        ? "hover:bg-ob-base-300 cursor-pointer"
                        : "cursor-default"
                    }`}
                    type="button"
                  >
                    {shouldTruncate && (
                      <span className="mt-0.5 text-ob-base-100 flex-shrink-0">
                        {isExpanded ? (
                          <CaretDownIcon size={16} />
                        ) : (
                          <CaretRightIcon size={16} />
                        )}
                      </span>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium font-serif">{displayTitle}</p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className="text-xs text-ob-base-100 font-sans">
                          {formatDate(paper.savedAt)}
                        </span>
                        {/* Show tags preview when collapsed */}
                        {!isExpanded && paper.tags.length > 0 && (
                          <div className="flex gap-1">
                            {paper.tags.slice(0, 2).map((tag) => (
                              <span
                                key={tag}
                                className="text-xs px-1.5 py-0.5 border border-accent-academic bg-accent-bg text-accent-academic font-sans"
                              >
                                {tag}
                              </span>
                            ))}
                            {paper.tags.length > 2 && (
                              <span className="text-xs text-ob-base-100 font-sans">
                                +{paper.tags.length - 2}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>

                  {/* Expanded Section */}
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-2 border-t border-ob-border pt-2">
                      {/* All tags when expanded */}
                      {paper.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {paper.tags.map((tag) => (
                            <span
                              key={tag}
                              className="text-xs px-1.5 py-0.5 border border-accent-academic bg-accent-bg text-accent-academic font-sans"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Action Buttons */}
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleSummarize(paper.arxivId)}
                          className="flex-1 text-xs font-sans"
                        >
                          <BookOpenIcon size={14} />
                          <span>Summarize</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          shape="square"
                          onClick={() => handleView(paper.arxivId)}
                          tooltip="View on arXiv"
                        >
                          <ArrowSquareOutIcon size={14} />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          shape="square"
                          onClick={() => handleRemove(paper.arxivId)}
                          tooltip="Remove from library"
                        >
                          <TrashIcon size={14} />
                        </Button>
                      </div>
                    </div>
                  )}
                </Card>
              );
            })
          )}
        </div>
    </div>
  );
};
