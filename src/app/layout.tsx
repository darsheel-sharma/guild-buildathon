import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Autonomous SDR — control plane",
  description:
    "Multi-channel autonomous SDR: campaign control plane plus an agentic outreach engine.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
            <Link href="/" className="flex items-baseline gap-3">
              <span className="text-[15px] font-medium">Autonomous SDR</span>
              <span className="text-xs text-ink-faint">control plane</span>
            </Link>
            <nav className="flex items-center gap-5 text-[13px] text-ink-soft">
              <Link href="/" className="hover:text-ink">
                Campaigns
              </Link>
              <Link href="/architecture" className="hover:text-ink">
                Architecture
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-6">{children}</main>
        <footer className="border-t border-line px-6 py-4 text-center text-xs text-ink-faint">
          Built for the Inter Guild Buildathon · control plane, shared platform and agent layer in
          one codebase
        </footer>
      </body>
    </html>
  );
}
