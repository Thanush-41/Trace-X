import { Suspense } from "react";
import { Brand, MobileNav, SidebarNav, StaticSidebarNav } from "@/components/nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-nav-line bg-nav text-nav-ink md:flex" aria-label="Sidebar">
        <div className="px-5 pb-4 pt-5"><Brand /></div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="Main">
          <Suspense fallback={<StaticSidebarNav />}>
            <SidebarNav />
          </Suspense>
        </nav>
        <div className="space-y-3 border-t border-nav-line px-4 py-4">
          <ThemeToggle />
          <Suspense fallback={null}>
            <UserMenu variant="sidebar" />
          </Suspense>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-nav-line bg-nav px-4 py-2.5 text-nav-ink md:hidden">
          <Suspense fallback={null}>
            <MobileNav footer={<><ThemeToggle /><Suspense fallback={null}><UserMenu variant="sidebar" /></Suspense></>} />
          </Suspense>
          <Brand />
        </header>
        <main className="fade-in mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
        <footer className="px-4 py-4 text-center text-xs text-ink-3 md:px-8">
          TRACE X · cross-system fraud intelligence · scores are explained by the signals and records shown on each alert
        </footer>
      </div>
    </div>
  );
}
