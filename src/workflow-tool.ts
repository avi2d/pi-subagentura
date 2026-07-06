import { Type } from "typebox";
import { startSubagentJob, debugLog } from "./helpers";
import { launchInteractiveSubagent } from "./interactive-tmux";
import {
  MAX_ITEMS_PER_CALL,
  MAX_TOTAL_AGENTS,
  listSavedWorkflows,
  loadWorkflowScript,
  parseWorkflow,
  saveWorkflowScript,
  type WorkflowAgentRunner,
  type WorkflowMeta,
} from "./workflow-core";
import {
  startWorkflowJob,
  workflowJobRegistry,
  type WorkflowJobState,
} from "./workflow-jobs";
import { renderProgress } from "./workflow-ui";
import {
  awaitInteractiveResult,
  runWorkflow,
  stringify,
} from "./workflow-worker";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerWorkflowTool(pi: ExtensionAPI): void {
  debugLog("info", "workflow_registered", {});
  // Build the real spawn function from the tool ctx. Switches backend on `isolation`.
  function makeRunAgent(ctx: any): WorkflowAgentRunner {
    return async ({
      prompt,
      persona,
      model,
      signal,
      isolation,
      label,
      onProgress,
    }) => {
      // Track last update time per agent label to throttle mid-agent previews
      const lastUpdateKey = `wf_update_${label ?? ""}`;
      let lastUpdateTs = 0;
      const THROTTLE_MS = 2000;

      const maybeEmitUpdate = (msg: string) => {
        const now = Date.now();
        if (now - lastUpdateTs >= THROTTLE_MS) {
          lastUpdateTs = now;
          onProgress?.({ kind: "log", message: msg, label });
        }
      };

      if (isolation === "process") {
        try {
          const state = launchInteractiveSubagent({
            name: (label || "wf-agent").slice(0, 40),
            task: prompt,
            persona,
            model,
            cwd: ctx.cwd,
            contextText: null,
            background: true,
          });
          const result = await awaitInteractiveResult(state, signal);
          return result;
        } catch (err) {
          // tmux/zellij unavailable — fall back to in-process, with visible warning.
          const msg = err instanceof Error ? err.message : String(err);
          debugLog("warn", "isolation_process_fallback", { reason: msg });
          onProgress?.({
            kind: "log",
            message: `⚠ isolation:process unavailable — ${msg}. Falling back to in-process.`,
            label,
          });
          const { jobPromise } = await startSubagentJob({
            task: `[isolation:process unavailable — ran in-process; reason: ${msg}]\n\n${prompt}`,
            persona,
            modelOverride: model,
            cwd: ctx.cwd,
            contextText: null,
            signal,
            onUpdate: (partial) => {
              const status = partial.details?.subagentStatus;
              if (status?.activeTool) {
                maybeEmitUpdate(`⚙ ${status.activeTool.name}`);
              } else if (status?.output) {
                const preview = (status.output || "")
                  .slice(0, 60)
                  .replace(/\s+/g, " ")
                  .trim();
                if (preview) maybeEmitUpdate(`💭 ${preview}`);
              }
            },
            defaultModel: ctx.model,
            parentModelRegistry: ctx.modelRegistry,
          });
          return jobPromise;
        }
      }
      const { jobPromise } = await startSubagentJob({
        task: prompt,
        persona,
        modelOverride: model,
        cwd: ctx.cwd,
        contextText: null,
        signal,
        onUpdate: (partial) => {
          const status = partial.details?.subagentStatus;
          if (status?.activeTool) {
            maybeEmitUpdate(`⚙ ${status.activeTool.name}`);
          } else if (status?.output) {
            const preview = (status.output || "")
              .slice(0, 60)
              .replace(/\s+/g, " ")
              .trim();
            if (preview) maybeEmitUpdate(`💭 ${preview}`);
          }
        },
        defaultModel: ctx.model,
        parentModelRegistry: ctx.modelRegistry,
      });
      return jobPromise;
    };
  }

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Run an agent-authored JavaScript workflow that deterministically orchestrates ISOLATED",
      "sub-agents. Intermediate results live in script variables, not your context window — fan out",
      "dozens of sub-agents (review pipelines, research sweeps, migrations) without context pressure.",
      "",
      "Script shape:",
      "  export const meta = { name: 'my-flow', description: '...', phases: [{ title: 'Scan' }] };",
      "  phase('Scan');",
      "  const out = await parallel([() => agent('task A'), () => agent('task B')]);",
      "  return out;",
      "",
      "Injected helpers/globals:",
      "  agent(prompt, opts?)   -> spawn one isolated sub-agent. opts: { schema?, label?, phase?,",
      "                            model?, persona?, isolation? }. Without schema returns the final text;",
      "                            with schema (a JSON Schema) returns a validated object, or null after",
      "                            retries. Returns null on error (filter with Boolean).",
      "                            isolation:'process' spawns a tmux/zellij Pi process (real isolation,",
      "                            attachable); falls back to in-process if no multiplexer is available.",
      "  parallel(thunks)       -> run `() => Promise` thunks concurrently (barrier); failures -> null.",
      "  pipeline(items, ...st) -> stream each item through stages, no barrier between stages.",
      "  workflow(name, args?)  -> run a saved workflow inline (one level deep).",
      "  phase(title) / log(msg)-> progress UI only.  args -> your `args`.  budget -> token accounting.",
      "",
      "Run a saved workflow by passing `name` instead of `script`. Pass `async: true` to run in the",
      "background (returns a workflowId; poll get_workflow_status / get_workflow_result). Up to 100 jobs; cancel with cancel_workflow.",
      "Constraints: Date.now()/Math.random()/argless new Date() throw; concurrency capped automatically;",
      `>${MAX_TOTAL_AGENTS} agents or >${MAX_ITEMS_PER_CALL} items per call throws. meta MUST be a pure literal.`,
    ].join("\n"),
    parameters: Type.Object({
      script: Type.Optional(
        Type.String({
          description:
            "The workflow script (export const meta + top-level body). Omit if using `name`.",
        }),
      ),
      name: Type.Optional(
        Type.String({
          description: "Name of a saved workflow to run (instead of `script`).",
        }),
      ),
      args: Type.Optional(
        Type.Unknown({
          description: "JSON value exposed to the script as `args`.",
        }),
      ),
      budget: Type.Optional(
        Type.Number({
          description:
            "Optional total output-token target; agent() throws once exhausted.",
        }),
      ),
      async: Type.Optional(
        Type.Boolean({
          description:
            "Run in the background and return a workflowId immediately.",
        }),
      ),
    }),

    async execute(
      _toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: any,
    ): Promise<any> {
      const script: string | null =
        typeof params.script === "string" && params.script.trim()
          ? params.script
          : params.name
            ? loadWorkflowScript(params.name)
            : null;
      if (!script) {
        const why = params.name
          ? `no saved workflow named "${params.name}"`
          : "provide `script` or `name`";
        return {
          content: [{ type: "text", text: `Workflow not run: ${why}.` }],
          details: { status: "error", error: why },
          isError: true,
        };
      }

      const runAgent = makeRunAgent(ctx);
      const baseOpts = {
        args: params.args,
        budgetTotal: params.budget ?? null,
        runAgent,
        loadWorkflow: (n: string) => loadWorkflowScript(n),
      };

      // ── Async (background) path ──
      if (params.async === true) {
        let meta: WorkflowMeta;
        try {
          meta = parseWorkflow(script).meta;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Workflow not started: ${msg}` }],
            details: { status: "error", error: msg },
            isError: true,
          };
        }
        const jobStartedAt = Date.now();
        let job: WorkflowJobState;
        try {
          job = startWorkflowJob(meta.name, script, baseOpts, jobStartedAt);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Workflow not started: ${msg}` }],
            details: { status: "error", error: msg },
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Workflow "${meta.name}" started in background as ${job.id}. Poll get_workflow_status / get_workflow_result.`,
            },
          ],
          details: { status: "started", workflowId: job.id, name: meta.name },
        };
      }

      // ── Synchronous (block-and-stream) path ──
      try {
        const run = await runWorkflow(script, {
          ...baseOpts,
          signal,
          onProgress: (p) => {
            try {
              onUpdate?.({
                content: [{ type: "text", text: renderProgress(p) }],
                details: {
                  status: "running",
                  agentsSpawned: p.agentsSpawned,
                  runningCount: p.runningCount,
                  errorCount: p.errorCount,
                  tokensSpent: p.tokensSpent,
                },
              });
            } catch {
              /* onUpdate is best-effort */
            }
          },
        });
        const resultText =
          typeof run.result === "string" ? run.result : stringify(run.result);
        const summary =
          `Workflow "${run.meta.name}" complete — ${run.agentsSpawned} agent(s), ` +
          `${run.errorCount} error(s), ${run.tokensSpent} output tokens.`;
        return {
          content: [{ type: "text", text: `${summary}\n\n${resultText}` }],
          details: {
            status: "done",
            name: run.meta.name,
            agentsSpawned: run.agentsSpawned,
            errorCount: run.errorCount,
            tokensSpent: run.tokensSpent,
            phases: run.phases,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Workflow failed: ${msg}` }],
          details: { status: "error", error: msg },
          isError: true,
        };
      }
    },
  });

  // ── get_workflow_status ──
  pi.registerTool({
    name: "get_workflow_status",
    label: "Workflow Status",
    description:
      "Poll a background workflow's live progress (agents spawned, errors, tokens, current phase).",
    parameters: Type.Object({
      workflowId: Type.String({
        description: "Workflow ID returned by an async `workflow` spawn.",
      }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      const st = workflowJobRegistry.get(params.workflowId);
      if (!st) {
        return {
          content: [
            { type: "text", text: `Workflow ${params.workflowId} not found.` },
          ],
          details: { status: "not_found", workflowId: params.workflowId },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Workflow "${st.name}" [${st.status}] — ${st.snapshot.agentsSpawned} agent(s)` +
              (st.snapshot.runningCount && st.snapshot.runningCount > 0
                ? `, ${st.snapshot.runningCount} running`
                : "") +
              `, ${st.snapshot.errorCount} error(s), ${st.snapshot.tokensSpent} tokens` +
              (st.snapshot.currentPhase
                ? `, phase: ${st.snapshot.currentPhase}`
                : "") +
              (st.error ? `\nerror: ${st.error}` : ""),
          },
        ],
        details: {
          status: st.status,
          workflowId: st.id,
          name: st.name,
          elapsedMs: Date.now() - st.startedAt,
          ...st.snapshot,
        },
      };
    },
  });

  // ── get_workflow_result ──
  pi.registerTool({
    name: "get_workflow_result",
    label: "Workflow Result",
    description:
      "Block until a background workflow finishes and return its final result.",
    parameters: Type.Object({
      workflowId: Type.String({
        description: "Workflow ID returned by an async `workflow` spawn.",
      }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      const st = workflowJobRegistry.get(params.workflowId);
      if (!st) {
        return {
          content: [
            { type: "text", text: `Workflow ${params.workflowId} not found.` },
          ],
          details: { status: "not_found", workflowId: params.workflowId },
          isError: true,
        };
      }
      try {
        const run = await st.promise;
        const resultText =
          typeof run.result === "string" ? run.result : stringify(run.result);
        return {
          content: [
            {
              type: "text",
              text:
                `Workflow "${run.meta.name}" complete — ${run.agentsSpawned} agent(s), ` +
                `${run.errorCount} error(s), ${run.tokensSpent} tokens.\n\n${resultText}`,
            },
          ],
          details: {
            status: "done",
            workflowId: st.id,
            name: run.meta.name,
            agentsSpawned: run.agentsSpawned,
            errorCount: run.errorCount,
            tokensSpent: run.tokensSpent,
            phases: run.phases,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text", text: `Workflow ${st.id} ${st.status}: ${msg}` },
          ],
          details: { status: st.status, workflowId: st.id, error: msg },
          isError: true,
        };
      }
    },
  });

  // ── cancel_workflow ──
  pi.registerTool({
    name: "cancel_workflow",
    label: "Cancel Workflow",
    description:
      "Abort a running background workflow (stops scheduling new agents; in-flight agents are signalled).",
    parameters: Type.Object({
      workflowId: Type.String({
        description: "Workflow ID returned by an async `workflow` spawn.",
      }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      const st = workflowJobRegistry.get(params.workflowId);
      if (!st) {
        return {
          content: [
            { type: "text", text: `Workflow ${params.workflowId} not found.` },
          ],
          details: { status: "not_found", workflowId: params.workflowId },
          isError: true,
        };
      }
      st.abort.abort();
      if (st.status === "running") st.status = "cancelled";
      return {
        content: [{ type: "text", text: `Workflow ${st.id} cancelled.` }],
        details: { status: "cancelled", workflowId: st.id },
      };
    },
  });

  // ── save_workflow ──
  pi.registerTool({
    name: "save_workflow",
    label: "Save Workflow",
    description:
      "Persist a workflow script under a name so it can be run later by `name` or composed via workflow(name).",
    parameters: Type.Object({
      name: Type.String({
        description: "Slug name (lowercase letters, digits, hyphens; max 64).",
      }),
      script: Type.String({
        description: "The workflow script to save (validated before writing).",
      }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      try {
        const file = saveWorkflowScript(params.name, params.script);
        return {
          content: [
            {
              type: "text",
              text: `Saved workflow "${params.name}" to ${file}.`,
            },
          ],
          details: { status: "saved", name: params.name, file },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Could not save workflow: ${msg}` }],
          details: { status: "error", error: msg },
          isError: true,
        };
      }
    },
  });

  // ── list_workflows ──
  pi.registerTool({
    name: "list_workflows",
    label: "List Workflows",
    description: "List saved workflows (name + description).",
    parameters: Type.Object({}),
    async execute(): Promise<any> {
      const items = listSavedWorkflows();
      const text = items.length
        ? items.map((w) => `- ${w.name}: ${w.description}`).join("\n")
        : "(no saved workflows)";
      return {
        content: [{ type: "text", text }],
        details: { status: "ok", workflows: items },
      };
    },
  });
}
