import {
  defaultConcurrency,
  defaultProcessConcurrency,
  type WorkflowAgentRunner,
} from "./workflow-core";

type WorkflowAgentRequest = Parameters<WorkflowAgentRunner>[0];
type WorkflowAgentResult = Awaited<ReturnType<WorkflowAgentRunner>>;

export interface WorkflowDispatcherOptions {
  inProcessCapacity?: number;
  processCapacity?: number;
}

export interface WorkflowDispatcher {
  run(
    request: WorkflowAgentRequest,
    runner: WorkflowAgentRunner,
  ): Promise<WorkflowAgentResult>;
}

interface Waiter {
  signal?: AbortSignal;
  queued: boolean;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
}

interface Lane {
  capacity: number;
  active: number;
  queue: Waiter[];
}

/** Shared raw-backend capacity for every job from one tool registration. */
export function createWorkflowDispatcher(
  options: WorkflowDispatcherOptions = {},
): WorkflowDispatcher {
  const inProcess = createLane(
    options.inProcessCapacity ?? defaultConcurrency(),
    "in-process",
  );
  const process = createLane(
    options.processCapacity ?? defaultProcessConcurrency(),
    "process",
  );

  return {
    async run(request, runner) {
      const lane = request.isolation === "in-process" ? inProcess : process;
      const release = await acquire(lane, request.signal);
      try {
        throwIfAborted(request.signal);
        return await runner(request);
      } finally {
        release();
      }
    },
  };
}

function createLane(capacity: number, name: string): Lane {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new Error(`${name} workflow capacity must be a positive integer`);
  }
  return {
    capacity,
    active: 0,
    queue: [],
  };
}

function acquire(lane: Lane, signal?: AbortSignal): Promise<() => void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      signal,
      queued: true,
      resolve,
      reject,
    };
    if (signal) {
      waiter.onAbort = () => {
        if (!waiter.queued) return;
        waiter.queued = false;
        const index = lane.queue.indexOf(waiter);
        if (index >= 0) lane.queue.splice(index, 1);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    lane.queue.push(waiter);
    pump(lane);
  });
}

function pump(lane: Lane): void {
  while (lane.active < lane.capacity) {
    const waiter = lane.queue.shift();
    if (!waiter) return;
    if (!waiter.queued) continue;
    waiter.queued = false;
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    if (waiter.signal?.aborted) {
      waiter.reject(abortReason(waiter.signal));
      continue;
    }

    lane.active++;
    if (waiter.signal?.aborted) {
      releaseLane(lane);
      waiter.reject(abortReason(waiter.signal));
      continue;
    }
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      releaseLane(lane);
    });
  }
}

function releaseLane(lane: Lane): void {
  lane.active--;
  pump(lane);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Workflow agent cancelled");
}
