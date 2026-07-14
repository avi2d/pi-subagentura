import {
  appendEvent,
  artifactPath,
  ensureArtifactDir,
  type CompletionOutcome,
  type SubagentArtifact,
} from "../../src/artifact";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function deterministicArtifact(
  root: string,
  id = "deterministic-agent",
): SubagentArtifact {
  return artifactPath(root, id);
}

export function appendDeterministicTurn(
  art: SubagentArtifact,
  index: number,
  output: string,
  outcome: CompletionOutcome = "done",
) {
  const turnId = `turn-${index}`;
  appendEvent(art, {
    version: 2,
    eventId: `start-${index}`,
    turnId,
    ts: index * 2 - 1,
    type: "turn_started",
    status: "running",
  });
  ensureArtifactDir(art);
  const eventId = `completion-${index}`;
  const outputDir = join(art.dir, "outputs");
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const outputPath = join(outputDir, `${eventId}.md`);
  writeFileSync(outputPath, output, { mode: 0o600 });
  const completion = {
    version: 2 as const,
    eventId,
    turnId,
    ts: index * 2,
    type: "completion" as const,
    status: outcome,
    outcome,
    source: "explicit" as const,
    exitCode: outcome === "done" ? 0 : 1,
    output: {
      path: outputPath,
      bytes: Buffer.byteLength(output, "utf8"),
      sha256: createHash("sha256").update(output).digest("hex"),
    },
  };
  appendEvent(art, completion);
  return completion;
}
