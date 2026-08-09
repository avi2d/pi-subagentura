const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const [compiledDir, rootDir, crashPoint] = process.argv.slice(2);

const owner = {
  projectKey: "crash-project",
  cwd: "/crash/repo",
  piSessionId: "crash-session",
  ownerId: "crash-owner",
  ownerGeneration: 1,
  leaseToken: "crash-lease",
};
const plan = {
  schemaVersion: 1,
  name: "crash-plan",
  phases: [
    {
      id: "phase",
      mode: "sequential",
      tasks: [
        { id: "task-a", prompt: "A", isolation: "in-process" },
        { id: "task-b", prompt: "B", isolation: "in-process" },
      ],
    },
  ],
};

function success(output) {
  return {
    isError: false,
    output,
    usage: {
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      cost: 0.25,
      turns: 1,
    },
    model: "test/model",
  };
}

function emit(point) {
  process.stdout.write(`${JSON.stringify({ point })}\n`);
}

function blockForever() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

async function main() {
  const [{ WorkflowRunStore }, { runDurableWorkflowPlan }] = await Promise.all([
    import(pathToFileURL(join(compiledDir, "workflow-run-store.js")).href),
    import(
      pathToFileURL(join(compiledDir, "workflow-durable-plan-runner.js")).href
    ),
  ]);
  const store = new WorkflowRunStore({ rootDir, owner });
  await runDurableWorkflowPlan({
    store,
    owner,
    runId: "crash-run",
    plan,
    runAgent: ({ prompt }) => {
      if (prompt === "A") return Promise.resolve(success("done:A"));
      if (crashPoint === "attempt-started") {
        emit("attempt-started");
        blockForever();
      }
      if (crashPoint === "provider-returned") {
        return {
          then(resolve) {
            resolve(success("uncommitted:B"));
            emit("provider-returned");
            blockForever();
          },
        };
      }
      throw new Error(`unknown crash point: ${crashPoint}`);
    },
  });
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
