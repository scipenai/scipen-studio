import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Trash2 } from "lucide-react";
import * as R from "../api/resources";
import { useApi } from "../hooks/useApi";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { EmptyRow, Table, Td, Th, Tr } from "../components/ui/Table";

export function Approvals() {
  const { t } = useTranslation();
  const [tenant, setTenant] = useState("");
  const [project, setProject] = useState("");
  const fetcher = useCallback(
    () =>
      R.listDecisions({
        tenant: tenant.trim() || undefined,
        project: project.trim() || undefined,
      }),
    [tenant, project],
  );
  const { data, error, loading, refresh } = useApi(fetcher);

  const onDelete = async (d: R.DecisionDto) => {
    if (!window.confirm(t("common.confirm_delete"))) return;
    await R.forgetDecision({
      tenant: d.tenant_id,
      project: d.project_id,
      tool: d.tool_name,
      input_signature: d.input_signature,
    });
    await refresh();
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900 dark:text-ink-50">
            {t("approvals.title")}
          </h1>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-400">
            {t("approvals.subtitle")}
          </p>
        </div>
        <Button onClick={() => void refresh()} variant="ghost" size="sm">
          <RefreshCw className="size-4" />
          {t("common.refresh")}
        </Button>
      </header>
      <Card>
        <div className="mb-3 flex flex-wrap gap-3">
          <FilterInput
            label={t("approvals.filter_tenant")}
            value={tenant}
            onChange={setTenant}
          />
          <FilterInput
            label={t("approvals.filter_project")}
            value={project}
            onChange={setProject}
          />
        </div>
        {error && (
          <div className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-900/30 dark:text-rose-200">
            {error}
          </div>
        )}
        {loading && !data ? (
          <div className="text-sm text-ink-500">{t("common.loading")}</div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("dashboard.tenant")}</Th>
                <Th>project</Th>
                <Th>{t("approvals.tool")}</Th>
                <Th>{t("approvals.decision")}</Th>
                <Th>{t("approvals.input_signature")}</Th>
                <Th>{t("approvals.decided_at")}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {(data?.decisions ?? []).length === 0 ? (
                <EmptyRow colSpan={7} message={t("approvals.empty")} />
              ) : (
                data!.decisions.map((d) => (
                  <Tr
                    key={`${d.tenant_id}/${d.project_id}/${d.tool_name}/${d.input_signature}`}
                  >
                    <Td className="font-mono text-xs">{d.tenant_id}</Td>
                    <Td className="font-mono text-xs">{d.project_id}</Td>
                    <Td className="font-mono text-xs">{d.tool_name}</Td>
                    <Td>
                      <Badge tone={d.decision === "allow" ? "success" : "danger"}>
                        {d.decision}
                      </Badge>
                    </Td>
                    <Td className="font-mono text-[11px] text-ink-500">
                      {d.input_signature || "—"}
                    </Td>
                    <Td className="font-mono text-xs">{d.decided_at}</Td>
                    <Td>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => void onDelete(d)}
                      >
                        <Trash2 className="size-4" />
                        {t("approvals.delete")}
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

function FilterInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="text-xs text-ink-500 dark:text-ink-400">
      <span className="mr-2">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-ink-300 bg-white px-2 py-1 text-xs text-ink-900 dark:border-ink-700 dark:bg-ink-950 dark:text-ink-100"
      />
    </label>
  );
}
