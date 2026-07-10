import { create } from "zustand";

const STORAGE_KEY = "snaca_token";

type AuthState = {
  token: string | null;
  login: (token: string) => void;
  logout: () => void;
};

function loadToken(): string | null {
  if (typeof localStorage === "undefined") return null;
  const value = localStorage.getItem(STORAGE_KEY);
  return value && value.length > 0 ? value : null;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: loadToken(),
  login: (token: string) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, token);
    }
    set({ token });
  },
  logout: () => {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
    }
    set({ token: null });
  },
}));

/**
 * Read the `?token=…` query param on hard load — same affordance the
 * server log link gives the operator. Once consumed, we strip it from
 * the URL so subsequent reloads don't re-bind a stale value.
 */
export function consumeTokenFromUrl() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const t = url.searchParams.get("token");
  if (t) {
    useAuthStore.getState().login(t);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.toString());
  }
}
