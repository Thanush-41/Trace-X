import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { NavLinks, StaticNavLinks } from "@/components/nav";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "TRACE X", template: "%s · TRACE X" },
  description: "Cross-system digital fraud detection and investigation",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-2.5">
            <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
              <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-accent text-sm text-white">X</span>
              TRACE X
            </Link>
            <nav className="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1" aria-label="Main">
              <Suspense fallback={<StaticNavLinks />}>
                <NavLinks />
              </Suspense>
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
        <footer className="border-t border-line py-4 text-center text-xs text-ink-3">
          TRACE X · cross-system fraud intelligence · synthetic demo data
        </footer>
      </body>
    </html>
  );
}
