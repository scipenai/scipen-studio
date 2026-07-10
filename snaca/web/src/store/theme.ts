import { create } from "zustand";

const STORAGE_KEY = "snaca_theme";

export type Theme = "light" | "dark" | "system";

type ThemeState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

function loadTheme(): Theme {
  if (typeof localStorage === "undefined") return "system";
  const value = localStorage.getItem(STORAGE_KEY);
  if (value === "light" || value === "dark" || value === "system") return value;
  return "system";
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: loadTheme(),
  setTheme: (theme: Theme) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, theme);
    }
    applyTheme(theme);
    set({ theme });
  },
}));

export function applyStoredTheme() {
  applyTheme(loadTheme());
}
