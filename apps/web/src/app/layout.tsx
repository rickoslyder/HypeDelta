import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { Providers } from "./providers";
import { CommandPalette } from "@/components/command-palette";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "HypeDelta - AI Intelligence Digest",
  description: "Weekly AI research intelligence aggregation and synthesis",
};

function Header() {
  return (
    <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 max-w-screen-2xl items-center px-4 md:px-6">
        <Link href="/" className="mr-6 flex items-center space-x-2">
          <span className="font-bold text-xl">HypeDelta</span>
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          <Link
            href="/digest"
            className="text-foreground/60 transition-colors hover:text-foreground"
          >
            Digest
          </Link>
          <Link
            href="/topics"
            className="text-foreground/60 transition-colors hover:text-foreground"
          >
            Topics
          </Link>
          <Link
            href="/claims"
            className="text-foreground/60 transition-colors hover:text-foreground"
          >
            Claims
          </Link>
          <Link
            href="/researchers"
            className="text-foreground/60 transition-colors hover:text-foreground"
          >
            Researchers
          </Link>
        </nav>
        <div className="flex flex-1 items-center justify-end gap-4">
          <CommandPalette
            topics={["agents", "scaling", "reasoning", "safety", "multimodal", "robotics", "rlhf", "interpretability"]}
          />
          <Link
            href="/admin"
            className="text-sm text-foreground/60 transition-colors hover:text-foreground"
          >
            Admin
          </Link>
        </div>
      </div>
    </header>
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen bg-background`}
      >
        <Providers>
          <div className="relative flex min-h-screen flex-col">
            <Header />
            <main className="flex-1">{children}</main>
            <footer className="border-t py-6 md:py-0">
              <div className="container flex h-14 max-w-screen-2xl items-center justify-between px-4 md:px-6 text-sm text-muted-foreground">
                <p>HypeDelta - AI Research Intelligence</p>
                <p>Updated weekly</p>
              </div>
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}
