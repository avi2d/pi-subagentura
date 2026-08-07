export type WorkflowEagerMode = "off" | "preferred" | "always";
export type WorkflowRoutingDecision =
  | { kind: "direct"; reason: string }
  | { kind: "durable_plan"; reason: string; mode: WorkflowEagerMode };

export interface WorkflowRoutingInput {
  mode: WorkflowEagerMode;
  text: string;
  hasActiveWorkflow?: boolean;
  awaitingUserInput?: boolean;
  childContext?: boolean;
  managementCommand?: boolean;
  planOnly?: boolean;
}

const SIMPLE_REQUEST =
  /^(?:what|why|how|when|where|who|can you|could you|please explain)\b/i;
const COMPLEX_MARKER =
  /\b(?:investigate|migrate|refactor|implement|audit|compare|review|debug|build|release|coordinate|analyze)\b/i;

export function decideWorkflowRouting(
  input: WorkflowRoutingInput,
): WorkflowRoutingDecision {
  const text = input.text.trim();
  if (input.mode === "off")
    return { kind: "direct", reason: "routing_disabled" };
  if (!text) return { kind: "direct", reason: "empty_request" };
  if (input.childContext) return { kind: "direct", reason: "child_context" };
  if (input.hasActiveWorkflow)
    return { kind: "direct", reason: "active_workflow" };
  if (input.awaitingUserInput)
    return { kind: "direct", reason: "awaiting_user_input" };
  if (input.managementCommand)
    return { kind: "direct", reason: "management_command" };
  if (input.planOnly) return { kind: "direct", reason: "plan_only" };
  if (SIMPLE_REQUEST.test(text) && input.mode === "preferred") {
    return { kind: "direct", reason: "simple_request" };
  }
  if (!COMPLEX_MARKER.test(text)) {
    return { kind: "direct", reason: "not_complex" };
  }
  return {
    kind: "durable_plan",
    reason: "eligible_complex_request",
    mode: input.mode,
  };
}
