"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { clsx } from "clsx";

type Theme = "light" | "dark" | "system";
const KEY = "tracex.theme";
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function apply(theme: Theme) {
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, read, () => "system" as Theme);
  const options: [Theme, typeof Sun, string][] = [["light", Sun, "Light"], ["dark", Moon, "Dark"], ["system", Monitor, "System"]];
  return (
    <div role="radiogroup" aria-label="Theme" className="flex rounded-lg bg-nav-hover p-0.5">
      {options.map(([value, Icon, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          title={`${label} theme`}
          onClick={() => apply(value)}
          className={clsx("flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs transition-colors", theme === value ? "bg-nav-active text-nav-strong" : "text-nav-ink hover:text-nav-strong")}
        >
          <Icon aria-hidden className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}
