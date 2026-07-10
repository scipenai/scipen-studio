import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../store/auth";
import { api } from "../api/client";
import { Button } from "../components/ui/Button";

export function Login() {
  const { t } = useTranslation();
  const token = useAuthStore((s) => s.token);
  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (token) {
    return <Navigate to={location.state?.from ?? "/"} replace />;
  }

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    login(value.trim());
    try {
      // Sanity-check the token against `/api/v1/status` before navigating
      // — this surfaces a wrong token immediately instead of letting the
      // landing dashboard render an empty screen.
      await api.get("/status");
      navigate(location.state?.from ?? "/", { replace: true });
    } catch {
      setError(t("login.invalid"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-ink-50 p-6 dark:bg-ink-950">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-xl border border-ink-200/70 bg-white p-6 shadow-lg dark:border-ink-800 dark:bg-ink-900"
      >
        <h1 className="text-xl font-semibold text-ink-900 dark:text-ink-50">
          {t("app.title")}
        </h1>
        <p className="mt-1 text-sm text-ink-500 dark:text-ink-400">
          {t("login.hint")}
        </p>
        <label className="mt-5 block text-xs font-medium uppercase tracking-wide text-ink-500 dark:text-ink-400">
          {t("login.title")}
        </label>
        <input
          autoFocus
          type="password"
          autoComplete="current-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("login.token_placeholder")}
          className="mt-1 w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-ink-700 dark:bg-ink-950 dark:text-ink-50"
        />
        {error && (
          <div className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-900/30 dark:text-rose-200">
            {error}
          </div>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={busy || value.trim().length === 0}
          className="mt-5 w-full justify-center"
        >
          {busy ? t("common.loading") : t("login.submit")}
        </Button>
      </form>
    </div>
  );
}
