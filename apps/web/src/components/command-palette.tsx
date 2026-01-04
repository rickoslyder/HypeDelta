"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import {
  FileText,
  TrendingUp,
  Users,
  MessageSquare,
  Settings,
  Database,
  Search,
  Home,
} from "lucide-react";

interface CommandPaletteProps {
  topics?: string[];
}

export function CommandPalette({ topics = [] }: CommandPaletteProps) {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();

  // Toggle the menu when Cmd+K is pressed
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };

    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const runCommand = React.useCallback((command: () => void) => {
    setOpen(false);
    command();
  }, []);

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-md border border-input bg-background hover:bg-accent"
      >
        <Search className="h-4 w-4" />
        <span className="hidden md:inline">Search...</span>
        <kbd className="hidden md:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
          <span className="text-xs">⌘</span>K
        </kbd>
      </button>

      {/* Command palette dialog */}
      <Command.Dialog
        open={open}
        onOpenChange={setOpen}
        label="Global Command Menu"
        className="fixed inset-0 z-50"
      >
        {/* Backdrop */}
        <div
          className="fixed inset-0 bg-black/50"
          onClick={() => setOpen(false)}
        />

        {/* Dialog content */}
        <div className="fixed left-[50%] top-[20%] z-50 w-full max-w-lg translate-x-[-50%] rounded-xl border bg-background shadow-2xl">
          <Command.Input
            placeholder="Type a command or search..."
            className="w-full border-b px-4 py-3 text-base outline-none placeholder:text-muted-foreground"
          />

          <Command.List className="max-h-[300px] overflow-y-auto p-2">
            <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
              No results found.
            </Command.Empty>

            <Command.Group heading="Navigation" className="py-2">
              <Command.Item
                onSelect={() => runCommand(() => router.push("/"))}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent aria-selected:bg-accent"
              >
                <Home className="h-4 w-4" />
                Home
              </Command.Item>
              <Command.Item
                onSelect={() => runCommand(() => router.push("/digest"))}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent aria-selected:bg-accent"
              >
                <FileText className="h-4 w-4" />
                Weekly Digest
              </Command.Item>
              <Command.Item
                onSelect={() => runCommand(() => router.push("/topics"))}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent aria-selected:bg-accent"
              >
                <TrendingUp className="h-4 w-4" />
                Topics
              </Command.Item>
              <Command.Item
                onSelect={() => runCommand(() => router.push("/claims"))}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent aria-selected:bg-accent"
              >
                <MessageSquare className="h-4 w-4" />
                Claims Browser
              </Command.Item>
              <Command.Item
                onSelect={() => runCommand(() => router.push("/researchers"))}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent aria-selected:bg-accent"
              >
                <Users className="h-4 w-4" />
                Researchers
              </Command.Item>
            </Command.Group>

            {topics.length > 0 && (
              <Command.Group heading="Topics" className="py-2">
                {topics.slice(0, 8).map((topic) => (
                  <Command.Item
                    key={topic}
                    onSelect={() => runCommand(() => router.push(`/topics/${topic}`))}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm capitalize hover:bg-accent aria-selected:bg-accent"
                  >
                    <TrendingUp className="h-4 w-4 text-muted-foreground" />
                    {topic}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            <Command.Group heading="Admin" className="py-2">
              <Command.Item
                onSelect={() => runCommand(() => router.push("/admin"))}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent aria-selected:bg-accent"
              >
                <Settings className="h-4 w-4" />
                Admin Dashboard
              </Command.Item>
              <Command.Item
                onSelect={() => runCommand(() => router.push("/admin/sources"))}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent aria-selected:bg-accent"
              >
                <Database className="h-4 w-4" />
                Sources
              </Command.Item>
            </Command.Group>
          </Command.List>

          <div className="border-t px-4 py-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">↑↓</kbd>
              Navigate
              <kbd className="ml-2 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">↵</kbd>
              Select
              <kbd className="ml-2 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">esc</kbd>
              Close
            </span>
          </div>
        </div>
      </Command.Dialog>
    </>
  );
}
