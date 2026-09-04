import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { Providers } from "./providers";
import { CommandPalette } from "@/components/command-palette";
import { ThemeToggle } from "@/components/theme-toggle";

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

const primaryLinks = [
  { href: "/digest", label: "Digest" },
  { href: "/topics", label: "Topics" },
  { href: "/claims", label: "Claims" },
  { href: "/predictions", label: "Predictions" },
  { href: "/reliability", label: "Reliability" },
  { href: "/researchers", label: "Researchers" },
];

function Header() {
  return (
    <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-14 w-full items-center px-4 md:px-8 lg:px-12">
        <Link href="/" className="mr-4 flex shrink-0 items-center lg:mr-6">
          <span className="font-bold text-xl">HypeDelta</span>
        </Link>
        <nav aria-label="Primary" className="hidden items-center gap-6 text-sm lg:flex">
          {primaryLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-foreground/60 transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <CommandPalette
            topics={["agents", "scaling", "reasoning", "safety", "multimodal", "robotics", "rlhf", "interpretability"]}
          />
          <ThemeToggle />
          <Link
            href="/admin"
            className="text-sm text-foreground/60 transition-colors hover:text-foreground"
          >
            Admin
          </Link>
        </div>
      </div>
      <nav
        aria-label="Primary mobile"
        className="flex gap-5 overflow-x-auto border-t px-4 py-2.5 text-sm lg:hidden md:px-8"
      >
        {primaryLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="shrink-0 whitespace-nowrap text-foreground/65 transition-colors hover:text-foreground"
          >
            {link.label}
          </Link>
        ))}
      </nav>
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
              <div className="flex h-14 w-full items-center justify-between px-4 md:px-8 lg:px-12 text-sm text-muted-foreground">
                <p>HypeDelta - AI Research Intelligence</p>
              </div>
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}
