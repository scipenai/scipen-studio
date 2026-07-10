import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, RotateCw } from "lucide-react";
import * as R from "../api/resources";
import { useApi } from "../hooks/useApi";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyRow, Table, Td, Th, Tr } from "../components/ui/Table";

export function Plugins() {
  const { t } = useTranslation();
  const fetcher = useCallback(() => R.listPlugins(), []);
  const { data, error, loading, refresh } = useApi(fetcher);
  const [reloading, setReloading] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);

  const onReload = async (name: string) => {
    setReloadError(null);
    setReloading(name);
    try {
      await R.reloadPlugin(name);
      await refresh();
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : String(e));
    } finally {
      setReloading(null);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900 dark:text-ink-50">
            {t("plugins.title")}
          </h1>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-400">
            {t("plugins.subtitle")}
          </p>
        </div>
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
      {reloadError && (
        <div className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
          {t("plugins.reload_failed")}: {reloadError}
        </div>
      )}
      <Card>
        {loading && !data ? (
          <div className="text-sm text-ink-500">{t("common.loading")}</div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("plugins.name")}</Th>
                <Th>{t("plugins.command")}</Th>
                <Th>{t("plugins.started")}</Th>
                <Th>{t("plugins.reloads")}</Th>
                <Th>{t("plugins.manifest_version")}</Th>
                <Th>{t("plugins.actions")}</Th>
              </tr>
            </thead>
            <tbody>
              {(data?.plugins ?? []).length === 0 ? (
                <EmptyRow colSpan={6} message={t("plugins.empty")} />
              ) : (
                data!.plugins.map((p) => (
                  <Tr key={p.name}>
                    <Td className="font-mono text-xs">{p.name}</Td>
                    <Td className="font-mono text-xs">
                      {p.command} {p.args.join(" ")}
                    </Td>
                    <Td className="font-mono text-xs">{p.started_at}</Td>
                    <Td>{p.reload_count}</Td>
                    <Td className="font-mono text-xs">
                      {p.manifest_version}
                    </Td>
                    <Td>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void onReload(p.name)}
                        disabled={reloading !== null}
                      >
                        <RotateCw
                          className={
                            reloading === p.name
                              ? "size-4 animate-spin"
                              : "size-4"
                          }
                        />
                        {reloading === p.name
                          ? t("plugins.reloading")
                          : t("plugins.reload")}
                      </Button>
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
