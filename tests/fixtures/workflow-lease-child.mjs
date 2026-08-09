import { once } from "node:events";
import { pathToFileURL } from "node:url";

const [
  command,
  rootDir,
  namespace,
  ownerId,
  leaseToken,
  staleAfterArg,
  nowArg,
  modulePath,
] = process.argv.slice(2);
const { WorkflowNamespaceLease } = await import(pathToFileURL(modulePath).href);
const staleAfterMs = staleAfterArg ? Number(staleAfterArg) : undefined;
const fixedNow = nowArg === undefined ? undefined : Number(nowArg);
const lease = new WorkflowNamespaceLease({
  rootDir,
  namespace,
  ownerId,
  leaseToken,
  ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
  ...(fixedNow === undefined ? {} : { now: () => fixedNow }),
  processId: process.pid,
  processStartTime: Math.floor(Date.now() - process.uptime() * 1000),
});

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  if (command !== "acquire" && command !== "hold") {
    throw new Error(`unknown command: ${command}`);
  }
  const record = await lease.acquire();
  emit({ ok: true, record });
  if (command === "hold") {
    await once(process.stdin, "end");
    await lease.release();
    emit({ ok: true, released: true });
  }
} catch (error) {
  emit({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
