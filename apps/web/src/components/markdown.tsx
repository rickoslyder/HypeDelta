"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

interface MarkdownProps {
  children: string;
  className?: string;
}

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      className={cn("markdown-content", className)}
      components={{
        // Headers
        h1: ({ children }) => (
          <h1 className="text-2xl font-bold mt-6 mb-4 first:mt-0">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-xl font-semibold mt-5 mb-3 first:mt-0 border-b pb-2">
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-lg font-semibold mt-4 mb-2">{children}</h3>
        ),
        h4: ({ children }) => (
          <h4 className="text-base font-semibold mt-3 mb-2">{children}</h4>
        ),

        // Paragraphs and text
        p: ({ children }) => (
          <p className="my-3 leading-relaxed text-sm">{children}</p>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold">{children}</strong>
        ),
        em: ({ children }) => <em className="italic">{children}</em>,

        // Lists
        ul: ({ children }) => (
          <ul className="my-3 ml-4 list-disc space-y-1">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-3 ml-4 list-decimal space-y-1">{children}</ol>
        ),
        li: ({ children }) => <li className="text-sm leading-relaxed">{children}</li>,

        // Links
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            {children}
          </a>
        ),

        // Blockquotes
        blockquote: ({ children }) => (
          <blockquote className="border-l-4 border-muted-foreground/30 pl-4 my-4 italic text-muted-foreground">
            {children}
          </blockquote>
        ),

        // Code
        code: ({ className, children }) => {
          const isBlock = className?.includes("language-");
          if (isBlock) {
            return (
              <code className="block bg-muted p-4 rounded-md text-xs overflow-x-auto my-3">
                {children}
              </code>
            );
          }
          return (
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">
              {children}
            </code>
          );
        },
        pre: ({ children }) => (
          <pre className="bg-muted rounded-md overflow-hidden my-3">{children}</pre>
        ),

        // Tables
        table: ({ children }) => (
          <div className="overflow-x-auto my-4">
            <table className="min-w-full divide-y divide-border text-sm">
              {children}
            </table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="bg-muted/50">{children}</thead>
        ),
        tbody: ({ children }) => (
          <tbody className="divide-y divide-border">{children}</tbody>
        ),
        tr: ({ children }) => <tr>{children}</tr>,
        th: ({ children }) => (
          <th className="px-3 py-2 text-left font-semibold">{children}</th>
        ),
        td: ({ children }) => <td className="px-3 py-2">{children}</td>,

        // Horizontal rule
        hr: () => <hr className="my-6 border-border" />,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
