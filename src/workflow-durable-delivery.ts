import type { WorkflowProjection } from "./workflow-projection-repository";
import { recoverWorkflowRun } from "./workflow-recovery";
import { WorkflowRunStore } from "./workflow-run-store";
import type {
  WorkflowOwnerIdentity,
  WorkflowRunStatus,
} from "./workflow-run-types";

export interface DurableWorkflowDeliveryMessage {
  runId: string;
  deliveryId: string;
  kind: "terminal";
  status: Extract<WorkflowRunStatus, "done" | "error" | "cancelled">;
  message: string;
  idempotencyKey: string;
}

export type DurableWorkflowDeliveryTransport = (
  message: DurableWorkflowDeliveryMessage,
  idempotencyKey: string,
) => Promise<void>;

export interface DurableWorkflowDeliveryTransportObject {
  send(
    message: DurableWorkflowDeliveryMessage,
    idempotencyKey: string,
  ): Promise<void>;
}

export type WorkflowDeliveryTransport =
  DurableWorkflowDeliveryTransport | DurableWorkflowDeliveryTransportObject;

export interface DurableWorkflowDeliveryBrokerOptions {
  store: WorkflowRunStore;
  owner: WorkflowOwnerIdentity;
  transport: WorkflowDeliveryTransport;
}

interface ClaimedDelivery {
  runId: string;
  deliveryId: string;
  ownerId: string;
  ownerGeneration: number;
  leaseEpoch: number;
  message: DurableWorkflowDeliveryMessage;
}

/**
 * Owner-scoped delivery broker for terminal workflow outbox intents.
 *
 * The dispatch event is the durable claim. A broker instance never sends the
 * same delivery twice after a successful transport call, while a failed call
 * remains retryable by that instance. A new broker can reclaim an abandoned
 * dispatch claim by writing a fresh fenced claim before retrying the transport.
 */
export class DurableWorkflowDeliveryBroker {
  private readonly attempts = new Map<
    string,
    Promise<WorkflowProjection | undefined>
  >();
  private readonly claimed = new Map<string, ClaimedDelivery>();
  private readonly retryable = new Set<string>();
  private readonly successful = new Map<string, ClaimedDelivery>();

  public constructor(
    private readonly options: DurableWorkflowDeliveryBrokerOptions,
  ) {}

  public async deliver(
    runId: string,
    deliveryId?: string,
  ): Promise<WorkflowProjection | undefined> {
    if (deliveryId) {
      return this.serialized(deliveryId, () =>
        this.deliverOnce(runId, deliveryId),
      );
    }
    const projection = await this.recover(runId);
    const resolvedDeliveryId = projection?.delivery?.deliveryId;
    if (!resolvedDeliveryId) return projection;
    return this.serialized(resolvedDeliveryId, () =>
      this.deliverOnce(runId, resolvedDeliveryId),
    );
  }

  /** Alias used by callers that name the operation after its outbox event. */
  public dispatch(
    runId: string,
    deliveryId?: string,
  ): Promise<WorkflowProjection | undefined> {
    return this.deliver(runId, deliveryId);
  }

  /** Confirm delivery through this broker's successful transport attempt. */
  public async acknowledge(
    runId: string,
    deliveryId: string,
  ): Promise<WorkflowProjection | undefined> {
    const active = this.attempts.get(deliveryId);
    if (active) return active;
    return this.serialized(deliveryId, () =>
      this.acknowledgeOnce(runId, deliveryId),
    );
  }

  public ack(
    runId: string,
    deliveryId: string,
  ): Promise<WorkflowProjection | undefined> {
    return this.acknowledge(runId, deliveryId);
  }

  private async serialized(
    deliveryId: string,
    operation: () => Promise<WorkflowProjection | undefined>,
  ): Promise<WorkflowProjection | undefined> {
    const previous = this.attempts.get(deliveryId);
    if (previous) return previous;
    const current = operation();
    this.attempts.set(deliveryId, current);
    try {
      return await current;
    } finally {
      if (this.attempts.get(deliveryId) === current)
        this.attempts.delete(deliveryId);
    }
  }

  private async deliverOnce(
    runId: string,
    deliveryId: string,
  ): Promise<WorkflowProjection | undefined> {
    let projection = await this.recover(runId);
    if (!projection || projection.delivery?.deliveryId !== deliveryId)
      return projection;
    if (projection.delivery.status === "delivered") return projection;

    const remembered = this.successful.get(deliveryId);
    if (remembered) return this.appendReceipt(runId, deliveryId);

    let claim = this.claimed.get(deliveryId);
    if (projection.delivery.status === "pending") {
      claim = await this.claimPending(runId, deliveryId);
      if (!claim) return this.recover(runId);
    } else if (projection.delivery.status === "dispatched") {
      if (this.retryable.has(deliveryId)) {
        this.retryable.delete(deliveryId);
        claim = this.claimed.get(deliveryId);
        if (!claim) {
          const fencedClaim = projection.delivery.claim;
          if (!fencedClaim) return this.recover(runId);
          claim = {
            runId,
            deliveryId,
            ownerId: fencedClaim.ownerId,
            ownerGeneration: fencedClaim.ownerGeneration,
            leaseEpoch: fencedClaim.leaseEpoch,
            message: this.messageFor(projection),
          };
          this.claimed.set(deliveryId, claim);
        }
      } else {
        claim = await this.reclaimDispatched(runId, deliveryId);
        if (!claim) return this.recover(runId);
      }
    }

    if (!claim) return projection;
    try {
      await this.send(claim.message);
      this.successful.set(deliveryId, claim);
      projection = await this.appendReceipt(runId, deliveryId);
      this.claimed.delete(deliveryId);
      return projection;
    } catch (error) {
      this.retryable.add(deliveryId);
      this.claimed.delete(deliveryId);
      throw error;
    }
  }

  private async reclaimDispatched(
    runId: string,
    deliveryId: string,
  ): Promise<ClaimedDelivery | undefined> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const projection = await this.recover(runId);
      if (!projection || projection.delivery?.deliveryId !== deliveryId)
        return undefined;
      if (projection.delivery.status === "delivered") return undefined;
      if (projection.delivery.status === "pending")
        return this.claimPending(runId, deliveryId);
      const leaseEpoch = await this.options.store.getLeaseEpoch();
      const appendResult = await this.options.store.appendIfCurrent(
        runId,
        projection.lastEventOrdinal,
        "delivery_dispatched",
        {
          deliveryId,
          ownerId: this.options.owner.ownerId,
          ownerGeneration: this.options.owner.ownerGeneration,
          leaseEpoch,
        },
        leaseEpoch,
      );
      if (appendResult.status === "conflict") continue;
      const claim: ClaimedDelivery = {
        runId,
        deliveryId,
        ownerId: this.options.owner.ownerId,
        ownerGeneration: this.options.owner.ownerGeneration,
        leaseEpoch,
        message: this.messageFor(projection),
      };
      this.claimed.set(deliveryId, claim);
      return claim;
    }
    return undefined;
  }

  private async claimPending(
    runId: string,
    deliveryId: string,
  ): Promise<ClaimedDelivery | undefined> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const projection = await this.recover(runId);
      if (!projection || projection.delivery?.deliveryId !== deliveryId)
        return undefined;
      if (projection.delivery.status === "delivered") return undefined;
      if (projection.delivery.status === "dispatched") {
        return this.claimed.get(deliveryId);
      }
      const leaseEpoch = await this.options.store.getLeaseEpoch();
      const appendResult = await this.options.store.appendIfCurrent(
        runId,
        projection.lastEventOrdinal,
        "delivery_dispatched",
        {
          deliveryId,
          ownerId: this.options.owner.ownerId,
          ownerGeneration: this.options.owner.ownerGeneration,
          leaseEpoch,
        },
        leaseEpoch,
      );
      if (appendResult.status === "conflict") continue;
      const claim: ClaimedDelivery = {
        runId,
        deliveryId,
        ownerId: this.options.owner.ownerId,
        ownerGeneration: this.options.owner.ownerGeneration,
        leaseEpoch,
        message: this.messageFor(projection),
      };
      this.claimed.set(deliveryId, claim);
      return claim;
    }
    return undefined;
  }

  private async acknowledgeOnce(
    runId: string,
    deliveryId: string,
  ): Promise<WorkflowProjection | undefined> {
    const projection = await this.recover(runId);
    if (!projection || projection.delivery?.deliveryId !== deliveryId)
      return projection;
    if (projection.delivery.status === "delivered") return projection;
    if (!this.successful.has(deliveryId))
      return this.deliverOnce(runId, deliveryId);
    return this.appendReceipt(runId, deliveryId);
  }

  private async appendReceipt(
    runId: string,
    deliveryId: string,
  ): Promise<WorkflowProjection | undefined> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const projection = await this.recover(runId);
      if (!projection || projection.delivery?.deliveryId !== deliveryId)
        return projection;
      if (projection.delivery.status === "delivered") return projection;
      const expectedClaim =
        this.successful.get(deliveryId) ?? this.claimed.get(deliveryId);
      const claim = projection.delivery.claim;
      if (
        !expectedClaim ||
        expectedClaim.runId !== runId ||
        !claim ||
        claim.ownerId !== expectedClaim.ownerId ||
        claim.ownerGeneration !== expectedClaim.ownerGeneration ||
        claim.leaseEpoch !== expectedClaim.leaseEpoch
      ) {
        return projection;
      }
      const leaseEpoch = await this.options.store.getLeaseEpoch();
      if (expectedClaim.leaseEpoch !== leaseEpoch) return projection;
      const appendResult = await this.options.store.appendIfCurrent(
        runId,
        projection.lastEventOrdinal,
        "delivery_receipt",
        {
          deliveryId,
          ownerId: this.options.owner.ownerId,
          ownerGeneration: this.options.owner.ownerGeneration,
          leaseEpoch,
        },
        leaseEpoch,
      );
      if (appendResult.status === "appended") return this.recover(runId);
    }
    return this.recover(runId);
  }

  private async send(message: DurableWorkflowDeliveryMessage): Promise<void> {
    const transport = this.options.transport;
    if (typeof transport === "function") {
      await transport(message, message.idempotencyKey);
      return;
    }
    await transport.send(message, message.idempotencyKey);
  }

  private messageFor(
    projection: WorkflowProjection,
  ): DurableWorkflowDeliveryMessage {
    const delivery = projection.delivery;
    if (!delivery) throw new Error("Workflow delivery intent is missing");
    const status = projection.terminal?.status;
    if (!status) throw new Error("Workflow terminal result is missing");
    return {
      runId: projection.runId,
      deliveryId: delivery.deliveryId,
      kind: delivery.kind,
      status,
      message: delivery.message,
      idempotencyKey: delivery.deliveryId,
    };
  }

  private async recover(
    runId: string,
  ): Promise<WorkflowProjection | undefined> {
    try {
      return await recoverWorkflowRun(
        { store: this.options.store, owner: this.options.owner },
        runId,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw error;
    }
  }
}
