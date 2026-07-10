import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import {
  CalendarClock,
  Cog,
  Gauge,
  Inbox,
  LogOut,
  MessageCircle,
  Moon,
  Plug,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { useAuthStore } from "../../store/auth";
import { useThemeStore } from "../../store/theme";
import { Button } from "../ui/Button";

const links = [
  { to: "/", icon: Gauge, key: "dashboard" },
  { to: "/plugins", icon: Plug, key: "plugins" },
  { to: "/threads", icon: MessageCircle, key: "threads" },
  { to: "/approvals", icon: ShieldCheck, key: "approvals" },
  { to: "/schedules", icon: CalendarClock, key: "schedules" },
  { to: "/outbox", icon: Inbox, key: "outbox" },
  { to: "/system", icon: Cog, key: "system" },
] as const;

export function Layout() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const onLogout = () => {
    logout();
    navigate("/login");
  };
  const toggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };
  const toggleLang = () => {
    const next = i18n.language.startsWith("zh") ? "en" : "zh";
    void i18n.changeLanguage(next);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("snaca_lang", next);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-ink-50 dark:bg-ink-950 lg:flex-row">
      <aside className="w-full border-b border-ink-200/70 bg-white p-4 dark:border-ink-800 dark:bg-ink-900 lg:w-60 lg:border-b-0 lg:border-r">
        <div className="mb-6 flex items-center justify-between lg:block">
          <div>
            <div className="text-lg font-semibold text-ink-900 dark:text-ink-50">
              {t("app.title")}
            </div>
            <div className="text-xs text-ink-500 dark:text-ink-400">
              {t("app.subtitle")}
            </div>
          </div>
        </div>
        <nav className="flex flex-row gap-1 overflow-x-auto lg:flex-col">
          {links.map(({ to, icon: Icon, key }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                clsx(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition",
                  isActive
                    ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200"
                    : "text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800",
                )
              }
            >
              <Icon className="size-4" />
              {t(`nav.${key}`)}
            </NavLink>
          ))}
        </nav>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={toggleTheme}>
            {theme === "dark" ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
            {t("nav.theme")}
          </Button>
          <Button size="sm" variant="ghost" onClick={toggleLang}>
            {i18n.language.startsWith("zh") ? "EN" : "中"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onLogout}>
            <LogOut className="size-4" />
            {t("nav.logout")}
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden p-4 lg:p-8">
        <Outlet />
      </main>
    </div>
  );
}
