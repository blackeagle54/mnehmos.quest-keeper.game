import React from 'react';
import { useGameStateStore } from '../../stores/gameStateStore';
import {
  useWorkflowStore,
  type WorkflowTemplate,
  type WorkflowTemplateDetail,
  type WorkflowRunResult,
} from '../../stores/workflowStore';

interface TemplateRowProps {
  template: WorkflowTemplate;
  selected: boolean;
  onSelect: (id: string) => void;
}

const TemplateRow: React.FC<TemplateRowProps> = ({ template, selected, onSelect }) => (
  <button
    data-testid={`workflow-template-${template.id}`}
    onClick={() => onSelect(template.id)}
    className={`w-full text-left border rounded p-3 transition-colors ${
      selected
        ? 'border-terminal-green bg-terminal-green/10'
        : 'border-terminal-green/30 bg-terminal-black hover:bg-terminal-green/5'
    }`}
  >
    <div className="font-bold uppercase tracking-wider text-terminal-green truncate">
      {template.name}
    </div>
    {template.description && (
      <div className="text-xs text-terminal-green/60 mt-1 line-clamp-2">
        {template.description}
      </div>
    )}
  </button>
);

interface RunResultPanelProps {
  run: WorkflowRunResult;
}

const RunResultPanel: React.FC<RunResultPanelProps> = ({ run }) => {
  const steps = run.results ?? run.steps ?? [];
  const failed = (run.failureCount ?? 0) > 0;
  return (
    <div
      data-testid="workflow-run-result"
      className={`mt-4 border rounded p-3 text-sm ${
        failed
          ? 'border-terminal-red/50 bg-terminal-red/10 text-terminal-red'
          : 'border-terminal-green/40 bg-terminal-green/5 text-terminal-green'
      }`}
    >
      <div className="font-bold uppercase tracking-wider mb-1">
        {run.autoExecuted ? 'Run complete' : 'Preview (dry-run)'}
      </div>
      {run.autoExecuted && (
        <div className="text-xs mb-2">
          Executed steps: {run.executedSteps ?? steps.length} · Failures: {run.failureCount ?? 0}
        </div>
      )}
      {steps.length > 0 && (
        <ol className="space-y-1 text-xs">
          {steps.map((step, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="text-terminal-green/40 shrink-0">#{i + 1}</span>
              <span className="truncate">{step.tool ?? 'step'}</span>
              {step.success === false || step.error ? (
                <span className="text-terminal-red shrink-0">✗ {step.error ?? 'failed'}</span>
              ) : step.success === true || step.resolved === true ? (
                // ✓ only on an AFFIRMATIVE outcome: executed-success or preview-resolved.
                <span className="text-terminal-green shrink-0">✓</span>
              ) : (
                // Unresolved/pending preview step — don't imply success it didn't earn.
                <span className="text-terminal-green/40 shrink-0">…</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};

export const WorkflowBrowserView: React.FC = () => {
  // gameState is the POV source of truth. Workflows can run without an active
  // character (a workflow may CREATE one), but we surface a hint when none is
  // selected so the player understands the starting state.
  const activeCharacterId = useGameStateStore((s) => s.activeCharacterId);

  const templates = useWorkflowStore((s) => s.templates);
  const selectedTemplateId = useWorkflowStore((s) => s.selectedTemplateId);
  const detail = useWorkflowStore((s) => s.detail);
  const lastRun = useWorkflowStore((s) => s.lastRun);
  const isLoading = useWorkflowStore((s) => s.isLoading);
  const error = useWorkflowStore((s) => s.error);
  const loadTemplates = useWorkflowStore((s) => s.loadTemplates);
  const loadDetail = useWorkflowStore((s) => s.loadDetail);
  const runWorkflow = useWorkflowStore((s) => s.runWorkflow);
  const setSelectedTemplateId = useWorkflowStore((s) => s.setSelectedTemplateId);

  // Local form + safety state. paramValues holds the user's required-param
  // inputs; confirmingRun gates the destructive autoExecute run behind an
  // explicit second click.
  const [paramValues, setParamValues] = React.useState<Record<string, string>>({});
  const [confirmingRun, setConfirmingRun] = React.useState(false);

  // Synchronous in-flight guard for the destructive autoExecute run. A ref (NOT
  // state) is required: two confirm clicks in the same tick both read React state
  // BEFORE a re-render, so only a synchronously-mutated ref can block the second
  // click from re-firing the mutating run.
  const isExecutingRef = React.useRef(false);
  // Same synchronous guard for the (non-destructive but still re-entrant) dry-run
  // preview, so rapid clicks can't enqueue overlapping previews whose responses
  // race to overwrite lastRun.
  const isPreviewingRef = React.useRef(false);

  // Discover templates on mount.
  React.useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  // Rehydrate the detail for a PERSISTED selection on mount: selectedTemplateId is
  // persisted (partialize) but detail is NOT, so a reloaded session lands with a
  // selection and no detail — and the render guards then show nothing. Mount-only:
  // handleSelect covers later user clicks, and depending on selectedTemplateId here
  // would double-load on every click (handleSelect already calls loadDetail).
  React.useEffect(() => {
    if (selectedTemplateId && !detail) {
      loadDetail(selectedTemplateId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset the per-template form + any armed confirm whenever the selection
  // changes, so stale params/confirm state can never leak across templates.
  React.useEffect(() => {
    setParamValues({});
    setConfirmingRun(false);
  }, [selectedTemplateId]);

  // Only treat the loaded detail as valid when it matches the CURRENT selection.
  // selectedTemplateId updates synchronously on click while `detail` loads async,
  // so during the load window (or after a stale response) detail can lag the
  // selection; rendering/running a mismatched template would execute the wrong one.
  const template: WorkflowTemplateDetail | null =
    detail?.template && detail.template.id === selectedTemplateId ? detail.template : null;
  const requiredParams = template?.requiredParams ?? [];

  const handleSelect = React.useCallback(
    (id: string) => {
      setSelectedTemplateId(id);
      loadDetail(id);
    },
    [setSelectedTemplateId, loadDetail]
  );

  const buildParams = React.useCallback((): Record<string, unknown> => {
    // Forward only the required-param inputs the engine asked for, trimmed of
    // empties so the engine can apply its own defaults/validation. A whitespace-only
    // entry is DROPPED (not forwarded as '') so it can't clobber an engine default.
    const out: Record<string, unknown> = {};
    for (const key of requiredParams) {
      const raw = paramValues[key];
      if (raw === undefined) continue;
      const v = raw.trim();
      if (v.length === 0) continue;
      out[key] = v;
    }
    return out;
  }, [requiredParams, paramValues]);

  // Dry-run preview: mutates NOTHING server-side, so it needs no confirm gate.
  const handlePreview = React.useCallback(() => {
    if (!selectedTemplateId || isPreviewingRef.current) return;
    isPreviewingRef.current = true;
    void Promise.resolve(
      runWorkflow(selectedTemplateId, buildParams(), { autoExecute: false })
    )
      .catch(() => {})
      .finally(() => {
        isPreviewingRef.current = false;
      });
  }, [selectedTemplateId, runWorkflow, buildParams]);

  // SAFETY: a workflow run mass-mutates game state, so the destructive
  // autoExecute:true call is two-step. The first Run click only ARMS the
  // confirm; the run fires ONLY from the explicit Execute (confirm) click.
  const handleArmRun = React.useCallback(() => {
    setConfirmingRun(true);
  }, []);

  const handleCancelRun = React.useCallback(() => {
    setConfirmingRun(false);
  }, []);

  const handleConfirmRun = React.useCallback(() => {
    // Guard the destructive run against same-tick double clicks (see isExecutingRef).
    if (!selectedTemplateId || isExecutingRef.current) return;
    isExecutingRef.current = true;
    setConfirmingRun(false);
    void Promise.resolve(
      runWorkflow(selectedTemplateId, buildParams(), { autoExecute: true })
    )
      .catch(() => {})
      .finally(() => {
        isExecutingRef.current = false;
      });
  }, [selectedTemplateId, runWorkflow, buildParams]);

  return (
    <div className="h-full w-full flex overflow-hidden">
      {/* Left: template list */}
      <div className="w-72 shrink-0 border-r border-terminal-green/20 flex flex-col overflow-hidden">
        <div className="border-b-2 border-terminal-green p-4 flex items-center justify-between">
          <h2 className="text-lg font-bold uppercase tracking-widest text-terminal-green flex items-center gap-2">
            <span>🔁</span> Workflows
          </h2>
          <button
            onClick={() => loadTemplates()}
            className="text-xs border border-terminal-green px-2 py-1 text-terminal-green hover:bg-terminal-green/10 transition-colors"
          >
            Refresh
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-thin scrollbar-thumb-terminal-green/20 scrollbar-track-transparent">
          {!activeCharacterId && (
            <div
              data-testid="workflow-no-character"
              className="text-xs text-terminal-green/50 border border-terminal-green/20 rounded p-2 mb-2"
            >
              No active character — a workflow may create one.
            </div>
          )}

          {isLoading && templates.length === 0 && (
            <div className="text-terminal-green/60 text-sm">Loading workflows…</div>
          )}

          {!isLoading && templates.length === 0 && (
            <div data-testid="workflow-empty" className="text-terminal-green/60 text-sm">
              No workflow templates available.
            </div>
          )}

          {templates.map((t) => (
            <TemplateRow
              key={t.id}
              template={t}
              selected={t.id === selectedTemplateId}
              onSelect={handleSelect}
            />
          ))}
        </div>
      </div>

      {/* Right: detail + run */}
      <div className="flex-1 overflow-y-auto p-6 scrollbar-thin scrollbar-thumb-terminal-green/20 scrollbar-track-transparent">
        {error && (
          <div className="mb-4 border border-terminal-red/50 bg-terminal-red/10 text-terminal-red px-3 py-2 rounded text-sm">
            {error}
          </div>
        )}

        {!template && (
          <div className="h-full flex items-center justify-center text-terminal-green/60">
            <div className="text-center space-y-2">
              <p className="text-xl">SELECT A WORKFLOW</p>
              <p className="text-sm">Choose a template from the list to view its steps.</p>
            </div>
          </div>
        )}

        {template && (
          <div data-testid="workflow-detail">
            <div className="border-b-2 border-terminal-green pb-3 mb-4">
              <h3 className="text-xl font-bold uppercase tracking-widest text-terminal-green">
                {template.name}
              </h3>
            </div>

            {/* Steps */}
            <div className="mb-6">
              <div className="text-xs text-terminal-green/60 uppercase tracking-wider mb-2">
                Steps
              </div>
              <ol className="space-y-2">
                {template.steps.map((step, i) => (
                  <li
                    key={i}
                    data-testid="workflow-step"
                    className="flex items-start gap-2 border border-terminal-green/30 bg-terminal-green/5 rounded p-2"
                  >
                    <span className="text-xs text-terminal-green/40 shrink-0 mt-0.5">
                      #{i + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm text-terminal-green font-bold truncate">
                        {step.tool ?? 'step'}
                      </div>
                      {step.description && (
                        <div className="text-xs text-terminal-green/60">{step.description}</div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            {/* Required params */}
            {requiredParams.length > 0 && (
              <div className="mb-6">
                <div className="text-xs text-terminal-green/60 uppercase tracking-wider mb-2">
                  Parameters
                </div>
                <div className="space-y-2">
                  {requiredParams.map((key) => (
                    <label key={key} className="block">
                      <span className="text-xs text-terminal-green/70">{key}</span>
                      <input
                        data-testid={`workflow-param-${key}`}
                        type="text"
                        value={paramValues[key] ?? ''}
                        onChange={(e) =>
                          setParamValues((prev) => ({ ...prev, [key]: e.target.value }))
                        }
                        className="mt-1 w-full bg-terminal-black border border-terminal-green/40 rounded px-2 py-1 text-sm text-terminal-green focus:outline-none focus:border-terminal-green"
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-3">
              <button
                data-testid="workflow-preview-button"
                onClick={handlePreview}
                disabled={isLoading}
                className="text-sm border border-terminal-green/60 px-4 py-2 text-terminal-green hover:bg-terminal-green/10 transition-colors rounded disabled:opacity-40"
              >
                Preview steps
              </button>

              {!confirmingRun && (
                <button
                  data-testid="workflow-run-button"
                  onClick={handleArmRun}
                  disabled={isLoading}
                  className="text-sm border border-terminal-green bg-terminal-green/10 px-4 py-2 text-terminal-green font-bold hover:bg-terminal-green/20 transition-colors rounded disabled:opacity-40"
                >
                  Run workflow
                </button>
              )}
            </div>

            {/* SAFETY: explicit confirm step before the destructive run. */}
            {confirmingRun && (
              <div className="mt-4 border border-terminal-red/50 bg-terminal-red/10 rounded p-3">
                <div className="text-sm text-terminal-red font-bold mb-2">
                  This will create/modify game entities. Confirm?
                </div>
                <div className="flex items-center gap-3">
                  <button
                    data-testid="workflow-run-confirm"
                    onClick={handleConfirmRun}
                    disabled={isLoading}
                    className="text-sm border border-terminal-red bg-terminal-red/20 px-4 py-2 text-terminal-red font-bold hover:bg-terminal-red/30 transition-colors rounded disabled:opacity-40"
                  >
                    Execute
                  </button>
                  <button
                    data-testid="workflow-run-cancel"
                    onClick={handleCancelRun}
                    className="text-sm border border-terminal-green/60 px-4 py-2 text-terminal-green hover:bg-terminal-green/10 transition-colors rounded"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Run / preview result — gated to the CURRENT selection so a result
                left over from a previously-run template can't show under this one. */}
            {lastRun && lastRun.templateId === selectedTemplateId && (
              <RunResultPanel run={lastRun} />
            )}
          </div>
        )}
      </div>
    </div>
  );
};
