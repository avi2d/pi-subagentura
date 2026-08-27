import type { CompletionConsumption } from "../src/completion-coordinator";

const interactiveTurnReceipt: CompletionConsumption = {
  schemaVersion: 1,
  source: "interactive",
  sourceId: "agent",
  turnId: "turn-1",
  consumedAt: 1,
  reason: "manual",
};

const sourceReceipt: CompletionConsumption = {
  schemaVersion: 1,
  source: "interactive",
  sourceId: "agent",
  scope: "source",
  consumedAt: 1,
  reason: "manual",
};

const inProcessReceipt: CompletionConsumption = {
  schemaVersion: 1,
  source: "in-process",
  sourceId: "job",
  consumedAt: 1,
  reason: "manual",
};

const workflowReceipt: CompletionConsumption = {
  schemaVersion: 1,
  source: "workflow",
  sourceId: "workflow",
  consumedAt: 1,
  reason: "manual",
};

void interactiveTurnReceipt;
void sourceReceipt;
void inProcessReceipt;
void workflowReceipt;

// @ts-expect-error Interactive turn-scoped receipts must identify their turn.
const missingInteractiveTurn: CompletionConsumption = {
  schemaVersion: 1,
  source: "interactive",
  sourceId: "agent",
  consumedAt: 1,
  reason: "manual",
};

// @ts-expect-error Non-interactive receipts are source-scoped and do not accept turnId.
const inProcessTurn: CompletionConsumption = {
  schemaVersion: 1,
  source: "in-process",
  sourceId: "job",
  turnId: "turn-1",
  consumedAt: 1,
  reason: "manual",
};
