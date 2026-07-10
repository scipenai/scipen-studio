import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import * as R from "../api/resources";
import { useApi } from "../hooks/useApi";
import { Button } from "../components/ui/Button";
import { StatTile } from "../components/ui/StatTile";

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function Dashboard() {
  const { t } = useTranslation();
  const fetcher = useCallback(() => R.status(), []);
  const { data, error, loading, refresh } = useApi(fetcher);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink-900 dark:text-ink-50">
          {t("dashboard.title")}
        </h1>
        <Button onClick={() => void refresh()} variant="ghost" size="sm">
          <RefreshCw className="size-4" />
          {t("common.refresh")}
        </Button>
      </header>
      {error && (
        <div className="rounded-md bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-900/30 dark:text-rose-200">
          {t("common.error")}: {error}
        </div>
      )}
      {loading && !data && (
        <div className="text-sm text-ink-500 dark:text-ink-400">
          {t("common.loading")}
        </div>
      )}
      {data && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label={t("dashboard.version")}
            value={<span className="font-mono text-base">{data.version}</span>}
          />
          <StatTile
            label={t("dashboard.uptime")}
            value={formatDuration(data.uptime_seconds)}
            hint={
              <span className="font-mono">
                {t("dashboard.started_at")}: {data.started_at}
              </span>
            }
          />
          <StatTile
            label={t("dashboard.tenant")}
            value={<span className="font-mono">{data.tenant_id}</span>}
          />
          <StatTile
            label={t("dashboard.llm")}
            value={
              <span className="font-mono">
                {data.llm_provider} / {data.llm_model}
              </span>
            }
          />
          <StatTile
            label={t("dashboard.plugin_count")}
            value={data.plugin_count}
          />
          <StatTile
            label={t("dashboard.mcp_count")}
            value={data.mcp_server_count}
          />
        </div>
      )}
    </div>
  );
}
