import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, RotateCw } from "lucide-react";
import * as R from "../api/resources";
import { useApi } from "../hooks/useApi";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { EmptyRow, Table, Td, Th, Tr } from "../components/ui/Table";

const STATUSES = ["", "pending", "failed", "delivered"] as const;

export function Outbox() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("");
  const fetcher = useCallback(
    () =>
      R.listOutbox({
        status: status || undefined,
        limit: 200,
      }),
    [status],
  );
  const { data, error, loading, refresh } = useApi(fetcher);

  const onRetry = async (id: string) => {
    await R.retryOutbox(id);
    await refresh();
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900 dark:text-ink-50">
            {t("outbox.title")}
          </h1>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-400">
            {t("outbox.subtitle")}
          </p>
        </div>
        <Button onClick={() => void refresh()} variant="ghost" size="sm">
          <RefreshCw className="size-4" />
          {t("common.refresh")}
        </Button>
      </header>
      <Card>
        <label className="mb-3 inline-flex items-center gap-2 text-xs text-ink-500 dark:text-ink-400">
          {t("outbox.filter_status")}:
          <select
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as (typeof STATUSES)[number])
            }
            className="rounded border border-ink-300 bg-white px-2 py-1 text-xs dark:border-ink-700 dark:bg-ink-950"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s || t("outbox.all")}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <div className="mb-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-900/30 dark:text-rose-200">
            {error}
          </div>
        )}
        {loading && !data ? (
          <div className="text-sm text-ink-500">{t("common.loading")}</div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("outbox.id")}</Th>
                <Th>{t("outbox.plugin")}</Th>
                <Th>{t("outbox.chat")}</Th>
                <Th>{t("outbox.kind")}</Th>
                <Th>{t("outbox.attempts")}</Th>
                <Th>{t("outbox.status")}</Th>
                <Th>{t("outbox.next_attempt")}</Th>
                <Th>{t("outbox.last_error")}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {(data?.outbox ?? []).length === 0 ? (
                <EmptyRow colSpan={9} message={t("outbox.empty")} />
              ) : (
                data!.outbox.map((row) => (
                  <Tr key={row.id}>
                    <Td className="font-mono text-[11px]">{row.id}</Td>
                    <Td className="font-mono text-xs">{row.plugin}</Td>
                    <Td className="font-mono text-xs">{row.chat_id}</Td>
                    <Td className="font-mono text-xs">{row.kind}</Td>
                    <Td>{row.attempts}</Td>
                    <Td>
                      <Badge
                        tone={
                          row.status === "delivered"
                            ? "success"
                            : row.status === "failed"
                              ? "danger"
                              : "info"
                        }
                      >
                        {row.status}
                      </Badge>
                    </Td>
                    <Td className="font-mono text-xs">{row.next_attempt_at}</Td>
                    <Td
                      className="max-w-[20rem] truncate text-xs text-rose-600 dark:text-rose-300"
                      title={row.last_error ?? ""}
                    >
                      {row.last_error ?? "—"}
                    </Td>
                    <Td>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void onRetry(row.id)}
                        disabled={row.status === "delivered"}
                      >
                        <RotateCw className="size-4" />
                        {t("outbox.retry")}
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
