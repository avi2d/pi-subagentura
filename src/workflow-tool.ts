import { Type } from "typebox";
import { abortableWait } from "./abortable-wait";
import { startSubagentJob, debugLog } from "./helpers";
import { launchInteractiveSubagent } from "./interactive-tmux";
import {
  MAX_ITEMS_PER_CALL,
  MAX_TOTAL_AGENTS,
  listSavedWorkflows,
  loadWorkflowScript,
  parseWorkflow,
  saveWorkflowScript,
  deleteWorkflowScript,
  type WorkflowAgentRunner,
  WorkflowExecutionError,
  type WorkflowMeta,
  type WorkflowRunResult,
  type WorkflowUsage,
  formatWorkflowUsage,
} from "./workflow-core";
import {
  getWorkflowCompletionPresentation,
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
import { sanitizeOutput } from "./notifications";
import { showWorkflowTree } from "./workflow-tree-ui";
import {
  WorkflowPickerComponent,
  type WorkflowPickerAction,
  type WorkflowPickerChoice,
} from "./workflow-picker-ui";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const WORKFLOW_SESSION_SCOPE_MESSAGE =
  "Workflow jobs are scoped to the current parent session and do not survive reload/resume/new/quit.";

function workflowNotFoundMessage(workflowId: string): string {
  return (
    `Workflow ${workflowId} not found in the current parent session. ` +
    "It may have been created in another session or removed by reload/resume/new/quit."
  );
}

function presentWorkflowUsage(
  usage: WorkflowUsage | undefined,
): WorkflowUsage | undefined {
  if (
    !usage ||
    (usage.totalTokens === 0 && usage.costUsd === 0 && usage.turns === 0)
  ) {
    return undefined;
  }
  return usage;
}

function workflowErrorUsage(error: unknown): WorkflowUsage | undefined {
  return error instanceof WorkflowExecutionError
    ? presentWorkflowUsage(error.usage)
    : undefined;
}

export function formatWorkflowNotificationSummary(
  job: WorkflowJobState,
): string {
  const run = job.result;
  if (run) {
    return (
      `${run.agentsSpawned} agent(s), ${run.errorCount} error(s), ` +
      `${run.tokensSpent} output tokens${run.usage ? ` (${formatWorkflowUsage(run.usage)})` : ""}.`
    );
  }
  const usage = presentWorkflowUsage(job.snapshot.usage);
  return `${job.error ?? "Workflow did not produce a result."}${usage ? ` (${formatWorkflowUsage(usage)})` : ""}`;
}

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
      onCancellationSnapshot,
    }) => {
      // Track last update time per agent label to throttle mid-agent previews

      let lastUpdateTs = 0;
      const THROTTLE_MS = 2000;

      const maybeEmitUpdate = (msg: string) => {
        const now = Date.now();
        if (now - lastUpdateTs >= THROTTLE_MS) {
          lastUpdateTs = now;
          onProgress?.({ kind: "log", message: msg, label });
        }
      };

      const tryProcess = isolation !== "in-process";
      if (tryProcess) {
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
          const result = await awaitInteractiveResult(
            state,
            signal,
            undefined,
            onCancellationSnapshot,
          );
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
          // fall through to in-process path below
        }
      }
      // In-process path: explicit isolation:"in-process" or fallback from failed process isolation
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
        onCancellationSnapshot,
        cancellationSource: "workflow",
      });
      return jobPromise;
    };
  }

  const MAX_WORKFLOW_NOTIFICATION_CHARS = 20_000;
  const WORKFLOW_TRUNCATION_MARKER = "\n\n[Content truncated.]";

  function truncateWorkflowNotification(text: string): string {
    if (text.length <= MAX_WORKFLOW_NOTIFICATION_CHARS) return text;
    const end =
      MAX_WORKFLOW_NOTIFICATION_CHARS - WORKFLOW_TRUNCATION_MARKER.length;
    return text.slice(0, Math.max(0, end)) + WORKFLOW_TRUNCATION_MARKER;
  }

  function notifyWorkflowCompletion(job: WorkflowJobState): boolean {
    const g2 = typeof global !== "undefined" ? global : globalThis;
    const currentPi = g2.__piSubagenturaPiRef as ExtensionAPI | undefined;
    const run = job.result;
    const errorCount = run?.errorCount ?? job.snapshot.errorCount;
    const presentation = getWorkflowCompletionPresentation(
      job.status,
      errorCount,
    );
    const icon = presentation.icon || (job.status === "done" ? "✅" : "❌");
    const rawSummary = formatWorkflowNotificationSummary(job);
    const summary = truncateWorkflowNotification(sanitizeOutput(rawSummary));
    let content = `${icon} Workflow "${job.name}" (${job.id}) ${presentation.label} — ${summary}`;
    if (run) {
      content += `\n\nCall get_workflow_result with workflowId "${job.id}" to retrieve the result.`;
    }
    if (!currentPi) return false;
    try {
      currentPi.sendMessage!(
        {
          customType: "workflow-notify",
          content,
          display: true,
          details: {
            workflowId: job.id,
            status: job.status,
            presentationStatus: presentation.label,
            usage: run?.usage ?? job.snapshot.usage,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      return true;
    } catch (err) {
      debugLog("warn", "workflow_completion_notification_failed", {
        workflowId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Run an agent-authored JavaScript workflow that deterministically orchestrates ISOLATED",
      "sub-agents. Intermediate results live in script variables, not your context window — fan out",
      "dozens of sub-agents (review pipelines, research sweeps, migrations) without context pressure.",
      "Workflow scripts are trusted agent-authored code, not arbitrary user input;",
      "the VM sandbox limits accidental Node globals but is not a security boundary.",
      "Do not run untrusted/user-supplied JavaScript as a workflow.",
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
      "                            with schema returns a value validated against the supported JSON Schema",
      "                            subset (type, enum, required/properties, additionalProperties, items,",
      "                            minItems, maxItems), or null after retries. Returns null on error",
      "                            (filter with Boolean).",
      "                            Defaults to tmux/zellij process isolation (attachable);",
      "                            falls back to in-process if no multiplexer is available.",
      "  parallel(thunks)       -> run `() => Promise` thunks concurrently (barrier); failures -> null.",
      "  pipeline(items, ...st) -> stream each item through stages, no barrier between stages.",
      "  workflow(name, args?)  -> run a saved workflow inline (one level deep).",
      "  phase(title) / log(msg)-> progress UI only.  args -> your `args`.  budget -> soft completed-output-token target; parallel in-flight calls may overshoot.",
      "",
      "Default: run in the background and return a workflowId immediately (async). Use async: false for synchronous execution.",
      "Poll with get_workflow_status / get_workflow_result. Up to 100 jobs; cancel with cancel_workflow.",
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
            "Optional soft completed-output-token target; in-flight calls may overshoot it, especially in parallel.",
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

      // ── Async (background) path — default ──
      if (params.async !== false) {
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
          job = startWorkflowJob(
            meta.name,
            script,
            baseOpts,
            jobStartedAt,
            notifyWorkflowCompletion,
          );
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
              text:
                `Workflow "${meta.name}" started in background as ${job.id}. ` +
                `Poll get_workflow_status / get_workflow_result. ${WORKFLOW_SESSION_SCOPE_MESSAGE}`,
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
                  usage: p.usage,
                },
              });
            } catch {
              /* onUpdate is best-effort */
            }
          },
        });
        const resultText =
          typeof run.result === "string" ? run.result : stringify(run.result);
        const presentation = getWorkflowCompletionPresentation(
          "done",
          run.errorCount,
        );
        const completionPrefix = presentation.icon
          ? `${presentation.icon} `
          : "";
        const completionLabel = presentation.icon
          ? presentation.label
          : "complete";
        const summary =
          `${completionPrefix}Workflow "${run.meta.name}" ${completionLabel} — ` +
          `${run.agentsSpawned} agent(s), ${run.errorCount} error(s), ${run.tokensSpent} output tokens (${formatWorkflowUsage(run.usage)}).`;
        return {
          content: [{ type: "text", text: `${summary}\n\n${resultText}` }],
          details: {
            status: "done",
            presentationStatus: presentation.label,
            name: run.meta.name,
            agentsSpawned: run.agentsSpawned,
            errorCount: run.errorCount,
            tokensSpent: run.tokensSpent,
            usage: run.usage,
            phases: run.phases,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const usage = workflowErrorUsage(err);
        const usageDetails = usage ? { usage } : {};
        return {
          content: [
            {
              type: "text",
              text: `Workflow failed: ${msg}${usage ? ` (${formatWorkflowUsage(usage)})` : ""}`,
            },
          ],
          details: { status: "error", error: msg, ...usageDetails },
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
      "Poll a background workflow's live progress (agents spawned, errors, output tokens, total usage, current phase).",
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
            { type: "text", text: workflowNotFoundMessage(params.workflowId) },
          ],
          details: { status: "not_found", workflowId: params.workflowId },
          isError: true,
        };
      }
      const errorCount = st.result?.errorCount ?? st.snapshot.errorCount;
      const presentation = getWorkflowCompletionPresentation(
        st.status,
        errorCount,
      );
      const statusPrefix = presentation.icon ? `${presentation.icon} ` : "";
      return {
        content: [
          {
            type: "text",
            text:
              `${statusPrefix}Workflow "${st.name}" [${presentation.label}] — ${st.snapshot.agentsSpawned} agent(s)` +
              (st.snapshot.runningCount && st.snapshot.runningCount > 0
                ? `, ${st.snapshot.runningCount} running`
                : "") +
              `, ${errorCount} error(s), ${st.snapshot.tokensSpent} output tokens` +
              (st.snapshot.usage
                ? ` (${formatWorkflowUsage(st.snapshot.usage)})`
                : "") +
              (st.snapshot.currentPhase
                ? `, phase: ${st.snapshot.currentPhase}`
                : "") +
              (st.error ? `\nerror: ${st.error}` : ""),
          },
        ],
        details: {
          status: st.status,
          presentationStatus: presentation.label,
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
    async execute(
      _id: string,
      params: any,
      signal?: AbortSignal,
    ): Promise<any> {
      const st = workflowJobRegistry.get(params.workflowId);
      if (!st) {
        return {
          content: [
            { type: "text", text: workflowNotFoundMessage(params.workflowId) },
          ],
          details: { status: "not_found", workflowId: params.workflowId },
          isError: true,
        };
      }

      // If signal is already aborted, return immediately
      if (signal?.aborted) {
        return {
          content: [
            {
              type: "text",
              text: `Wait for workflow ${st.id} cancelled.`,
            },
          ],
          details: { status: "wait_cancelled", workflowId: st.id },
          isError: true,
        };
      }

      // Race st.promise against the abort signal
      let run: WorkflowRunResult;
      try {
        const waitResult = await abortableWait(st.promise, signal);
        if (waitResult.aborted) {
          return {
            content: [
              {
                type: "text",
                text: `Wait for workflow ${st.id} cancelled.`,
              },
            ],
            details: { status: "wait_cancelled", workflowId: st.id },
            isError: true,
          };
        }
        run = waitResult.value!;
      } catch (err) {
        // Non-abort errors preserve the original structured handling
        const msg = err instanceof Error ? err.message : String(err);
        const usage = presentWorkflowUsage(st.snapshot.usage);
        const usageDetails = usage ? { usage } : {};
        return {
          content: [
            {
              type: "text",
              text: `Workflow ${st.id} ${st.status}: ${msg}${usage ? ` (${formatWorkflowUsage(usage)})` : ""}`,
            },
          ],
          details: {
            status: st.status,
            workflowId: st.id,
            error: msg,
            ...usageDetails,
          },
          isError: true,
        };
      }

      const resultText =
        typeof run.result === "string" ? run.result : stringify(run.result);
      const presentation = getWorkflowCompletionPresentation(
        "done",
        run.errorCount,
      );
      return {
        content: [
          {
            type: "text",
            text: (() => {
              const prefix = presentation.icon ? `${presentation.icon} ` : "";
              const label = presentation.icon ? presentation.label : "complete";
              return (
                `${prefix}Workflow "${run.meta.name}" ${label} — ` +
                `${run.agentsSpawned} agent(s), ${run.errorCount} error(s), ${run.tokensSpent} output tokens${run.usage ? ` (${formatWorkflowUsage(run.usage)})` : ""}.\n\n${resultText}`
              );
            })(),
          },
        ],
        details: {
          status: "done",
          presentationStatus: presentation.label,
          workflowId: st.id,
          name: run.meta.name,
          agentsSpawned: run.agentsSpawned,
          errorCount: run.errorCount,
          tokensSpent: run.tokensSpent,
          usage: run.usage,
          phases: run.phases,
        },
      };
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
            { type: "text", text: workflowNotFoundMessage(params.workflowId) },
          ],
          details: { status: "not_found", workflowId: params.workflowId },
          isError: true,
        };
      }
      if (st.status === "cancelled") {
        return {
          content: [
            { type: "text", text: `Workflow ${st.id} is already cancelled.` },
          ],
          details: {
            status: "cancelled",
            workflowId: st.id,
            cancelled: true,
          },
        };
      }
      if (st.status !== "running") {
        return {
          content: [
            {
              type: "text",
              text: `Workflow ${st.id} is already ${st.status}; nothing was cancelled.`,
            },
          ],
          details: {
            status: st.status,
            workflowId: st.id,
            cancelled: false,
          },
        };
      }
      st.abort.abort();
      st.status = "cancelled";
      return {
        content: [{ type: "text", text: `Workflow ${st.id} cancelled.` }],
        details: {
          status: "cancelled",
          workflowId: st.id,
          cancelled: true,
          snapshots: [...(st.cancellationSnapshots ?? [])],
        },
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

  // ── delete_workflow ──
  pi.registerTool({
    name: "delete_workflow",
    label: "Delete Workflow",
    description: "Delete a saved workflow by name.",
    parameters: Type.Object({
      name: Type.String({
        description: "Name of the saved workflow to delete.",
      }),
    }),
    async execute(_id: string, params: any): Promise<any> {
      try {
        const existed = deleteWorkflowScript(params.name);
        return {
          content: [
            {
              type: "text",
              text: existed
                ? `Deleted workflow "${params.name}".`
                : `No saved workflow named "${params.name}".`,
            },
          ],
          details: {
            status: existed ? "deleted" : "not_found",
            name: params.name,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text", text: `Could not delete workflow: ${msg}` },
          ],
          details: { status: "error", error: msg },
          isError: true,
        };
      }
    },
  });

  // ── Workflow user commands (guarded) ──
  if (typeof pi.registerCommand === "function") {
    const sendCommandMessage = (text: string) => {
      const sendMessage = (pi as any).sendMessage;
      if (typeof sendMessage === "function") {
        sendMessage.call(
          pi,
          {
            customType: "workflow-command",
            content: text,
            display: true,
          },
          { deliverAs: "followUp" },
        );
        return;
      }
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    };

    const sendWorkflowCreationPrompt = async (
      ctx: ExtensionCommandContext,
      task: string,
    ) => {
      const prompt = buildWorkflowCreationPrompt(task);
      const sendUserMessage = (ctx as any).sendUserMessage;
      if (typeof sendUserMessage === "function") {
        await sendUserMessage.call(ctx, prompt, { deliverAs: "followUp" });
        return;
      }
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    };

    const startSavedWorkflowFromCommand = (
      name: string,
      argsValue: unknown,
      ctx: ExtensionCommandContext,
    ) => {
      const script = loadWorkflowScript(name);
      if (!script) throw new Error(`No saved workflow named "${name}".`);
      const meta = parseWorkflow(script).meta;
      const job = startWorkflowJob(
        meta.name,
        script,
        {
          args: argsValue,
          budgetTotal: null,
          runAgent: makeRunAgent(ctx),
          loadWorkflow: (n: string) => loadWorkflowScript(n),
        },
        Date.now(),
        notifyWorkflowCompletion,
      );
      return { job, meta };
    };

    const selectSavedWorkflow = async (
      ui: ExtensionCommandContext["ui"],
      choices: WorkflowPickerChoice[],
    ): Promise<WorkflowPickerAction | undefined> => {
      const custom = (ui as any).custom;
      if (typeof custom === "function") {
        return custom.call(
          ui,
          (
            _tui: unknown,
            theme: unknown,
            _kb: unknown,
            done: (action: WorkflowPickerAction) => void,
          ) => new WorkflowPickerComponent(choices, theme as any, done),
        ) as Promise<WorkflowPickerAction | undefined>;
      }
      const deleteLabel = "🗑  Delete a workflow…";
      const labels = choices.map(
        (choice) =>
          `${choice.name} — ${choice.description || "(no description)"}`,
      );
      const selected = await ui.select("Select workflow:", [
        ...labels,
        "──────────────",
        deleteLabel,
      ]);
      if (!selected) return undefined;
      if (selected === deleteLabel) {
        const toDelete = await ui.select("Select workflow to delete:", labels);
        if (!toDelete) return undefined;
        const choice = choices.find(
          (candidate) =>
            `${candidate.name} — ${candidate.description || "(no description)"}` ===
            toDelete,
        );
        return choice ? { kind: "delete", name: choice.name } : undefined;
      }
      const choice = choices.find(
        (candidate) =>
          `${candidate.name} — ${candidate.description || "(no description)"}` ===
          selected,
      );
      return choice ? { kind: "run", name: choice.name } : undefined;
    };

    const runSavedWorkflowCommand = async (
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ) => {
      const items = listSavedWorkflows();
      const parsed = parseWorkflowCommandArgs(rawArgs);

      const choices = items.map((w) => ({
        name: w.name,
        description: w.description || "(no description)",
      }));

      if (items.length === 0) {
        const text =
          "No saved workflows. Use `/workflow <task>` to create one.";
        ctx.ui.notify(text);
        sendCommandMessage(text);
        return;
      }

      // If name was provided inline, try run it directly
      const inlineName = parsed.name;
      if (inlineName) {
        await runNamedWorkflow(inlineName, parsed, ctx);
        return;
      }

      const action = await selectSavedWorkflow(ctx.ui, choices);
      if (!action || action.kind === "cancel") return;
      if (action.kind === "delete") {
        deleteWorkflowScript(action.name);
        const text = `Deleted workflow "${action.name}".`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
        return;
      }

      await runNamedWorkflow(action.name, parsed, ctx);
    };

    async function runNamedWorkflow(
      name: string,
      parsed: { name: string | null; argsJson: string | null },
      ctx: ExtensionCommandContext,
    ) {
      const items = listSavedWorkflows();
      const known = items.some((w) => w.name === name);
      if (!known) {
        const text = `No saved workflow named "${name}".`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
        return;
      }
      try {
        const argsValue = parsed.argsJson
          ? parseArgsJson(parsed.argsJson)
          : await promptForWorkflowArgs(ctx);
        if (argsValue === CANCELLED_ARGS_PROMPT) return;
        const { job, meta } = startSavedWorkflowFromCommand(
          name,
          argsValue,
          ctx,
        );
        const text =
          `Workflow "${meta.name}" started in background as ${job.id}. ` +
          `${WORKFLOW_SESSION_SCOPE_MESSAGE} Use /workflow-status to inspect running jobs.`;
        ctx.ui.notify(`Started workflow ${meta.name}.`);
        sendCommandMessage(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const text = `Workflow not started: ${msg}`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      }
    }

    pi.registerCommand("workflow", {
      description:
        "Create a reusable workflow from a task, save it, and run it immediately.",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const inlineTask = args.trim();
        const editor = (ctx.ui as any).editor;
        const input = (ctx.ui as any).input;
        const promptedTask =
          !inlineTask && typeof editor === "function"
            ? await editor.call(ctx.ui, "Workflow task:", "")
            : !inlineTask && typeof input === "function"
              ? await input.call(ctx.ui, "Workflow task:", "")
              : "";
        const task =
          inlineTask || (promptedTask == null ? "" : String(promptedTask));
        if (!task.trim()) {
          ctx.ui.notify("Workflow task is required.");
          return;
        }
        ctx.ui.notify("Creating workflow from task.");
        await sendWorkflowCreationPrompt(ctx, task.trim());
      },
    });

    pi.registerCommand("workflows", {
      description: "List saved workflows, select one, and run it.",
      handler: runSavedWorkflowCommand,
    });

    pi.registerCommand("list-workflows", {
      description: "Alias for /workflows.",
      handler: runSavedWorkflowCommand,
    });

    pi.registerCommand("workflow-status", {
      description:
        "List running and completed workflow jobs with status, agent counts, output tokens, total usage, and elapsed time.",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const text = renderWorkflowJobs();
        ctx.ui.notify("📋 Workflow status listed.");
        sendCommandMessage(text);
      },
    });

    pi.registerCommand("workflow-tree", {
      description:
        "Open an interactive workflow tree with expand/collapse and cancel controls.",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const action = await showWorkflowTree(ctx.ui);
        if (action.kind === "cancel") {
          sendCommandMessage(`Workflow ${action.workflowId} cancelled.`);
        }
      },
    });

    pi.registerCommand("delete-workflow", {
      description:
        "Delete a saved workflow by name (interactive picker if no name given).",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const items = listSavedWorkflows();
        if (items.length === 0) {
          const text = "No saved workflows to delete.";
          ctx.ui.notify(text);
          sendCommandMessage(text);
          return;
        }
        const choices = items.map((w) => ({
          name: w.name,
          label: `${w.name} — ${w.description || "(no description)"}`,
        }));
        let name = args.trim();
        if (!name) {
          const selected = await ctx.ui.select(
            "Select workflow to delete:",
            choices.map((c) => c.label),
          );
          const choice = choices.find((c) => c.label === selected);
          if (!choice) return;
          name = choice.name;
        }
        const known = items.some((w) => w.name === name);
        if (!known) {
          const text = `No saved workflow named "${name}".`;
          ctx.ui.notify(text);
          sendCommandMessage(text);
          return;
        }
        deleteWorkflowScript(name);
        const text = `Deleted workflow "${name}".`;
        ctx.ui.notify(text);
        sendCommandMessage(text);
      },
    });
  }
  const CANCELLED_ARGS_PROMPT = Symbol("cancelled-workflow-args");

  function parseWorkflowCommandArgs(raw: string): {
    name: string | null;
    argsJson: string | null;
  } {
    const trimmed = raw.trim();
    const firstSpace = trimmed.search(/\s/);
    if (!trimmed) return { name: null, argsJson: null };
    if (firstSpace === -1) return { name: trimmed, argsJson: null };
    return {
      name: trimmed.slice(0, firstSpace),
      argsJson: trimmed.slice(firstSpace).trim() || null,
    };
  }

  function parseArgsJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Workflow args must be valid JSON: ${msg}`);
    }
  }

  async function promptForWorkflowArgs(
    ctx: ExtensionCommandContext,
  ): Promise<unknown | typeof CANCELLED_ARGS_PROMPT> {
    const editor = (ctx.ui as any).editor;
    const input = (ctx.ui as any).input;
    const raw =
      typeof editor === "function"
        ? await editor.call(ctx.ui, "Workflow args JSON (optional):", "{}")
        : typeof input === "function"
          ? await input.call(ctx.ui, "Workflow args JSON (optional):", "{}")
          : "{}";
    if (raw == null) return CANCELLED_ARGS_PROMPT;
    const trimmed = String(raw).trim();
    return trimmed ? parseArgsJson(trimmed) : undefined;
  }

  function buildWorkflowCreationPrompt(task: string): string {
    return [
      "You are handling the `/workflow <task>` command.",
      "",
      "Create a reusable JavaScript workflow for the user's task, save it, and run it immediately.",
      "",
      "Requirements:",
      "1. Design a bounded workflow script with `export const meta = { name, description, phases }`.",
      "2. The workflow should accept its task/config through `args` so it can be reused later.",
      "3. Save the script with `save_workflow` using a lowercase slug name.",
      "4. Immediately start it with the `workflow` tool by saved `name` and suitable `args`.",
      "5. Do not use Node APIs inside the workflow script; file I/O must happen inside sub-agents via tools.",
      "6. Do not set `isolation` unless the workflow explicitly needs to opt out; workflow agents default to tmux/zellij process isolation and fall back to in-process automatically.",
      "7. Report the saved workflow name and returned workflowId.",
      "",
      "User task:",
      task,
    ].join("\n");
  }

  function renderWorkflowJobs(): string {
    const lines: string[] = [];
    const now = Date.now();
    let count = 0;
    for (const st of workflowJobRegistry.values()) {
      count++;
      const elapsed = formatElapsed(now - st.startedAt);
      const s = st.snapshot;
      const errorCount = st.result?.errorCount ?? s.errorCount;
      const presentation = getWorkflowCompletionPresentation(
        st.status,
        errorCount,
      );
      const statusPrefix = presentation.icon ? `${presentation.icon} ` : "";
      const parts: string[] = [
        `**${st.name}** (${st.id}) [${statusPrefix}${presentation.label}]`,
        `${s.agentsSpawned} agent(s)`,
      ];
      if (s.runningCount && s.runningCount > 0) {
        parts.push(`⚡ ${s.runningCount} running`);
      }
      if (errorCount > 0) parts.push(`⚠ ${errorCount} error(s)`);
      parts.push(`${s.tokensSpent} output tokens`);
      if (s.usage) parts.push(formatWorkflowUsage(s.usage));
      parts.push(elapsed);
      if (s.currentPhase) parts.push(`phase: ${s.currentPhase}`);
      if (st.error) parts.push(`error: ${st.error}`);
      lines.push(`- ${parts.join(" · ")}`);
      if (s.lastMessage && count <= 20) lines.push(`  last: ${s.lastMessage}`);
    }
    return count === 0
      ? "No workflow jobs."
      : `**Workflow jobs (${count})**\n` + lines.join("\n");
  }

  function formatElapsed(ms: number): string {
    if (ms < 0) return "0s";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
}
