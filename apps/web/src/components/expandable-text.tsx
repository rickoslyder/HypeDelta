"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

interface ExpandableTextProps {
  text: string;
  maxLength?: number;
  className?: string;
}

export function ExpandableText({
  text,
  maxLength = 50,
  className,
}: ExpandableTextProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Don't show expand button if text is short enough
  if (!text || text.length <= maxLength) {
    return <span className={className}>{text}</span>;
  }

  const displayText = isExpanded ? text : `${text.slice(0, maxLength)}...`;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsExpanded(!isExpanded);
      }}
      className={cn(
        "text-left inline-flex items-start gap-1 hover:text-foreground transition-colors",
        className
      )}
    >
      <span className={isExpanded ? "" : "truncate"}>{displayText}</span>
      {isExpanded ? (
        <ChevronUp className="h-3 w-3 flex-shrink-0 mt-0.5" />
      ) : (
        <ChevronDown className="h-3 w-3 flex-shrink-0 mt-0.5" />
      )}
    </button>
  );
}
