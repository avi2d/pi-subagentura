import { isProxy } from "node:util/types";

export type DurableValue =
  | null
  | boolean
  | number
  | string
  | DurableValue[]
  | { [key: string]: DurableValue };

const MAX_DURABLE_VALUE_DEPTH = 64;
const MAX_DURABLE_VALUE_NODES = 100_000;
const MAX_DURABLE_STRING_BYTES = 256 * 1024;
const MAX_DURABLE_VALUE_BYTES = 256 * 1024;
const SAFE_KEY = /^[A-Za-z0-9_.-]{1,128}$/;
const UNSAFE_KEYS = {
  ["__proto__"]: true,
  constructor: true,
  prototype: true,
} as const satisfies Readonly<Record<string, boolean>>;

type PathSegment = string | number;

interface TraversalResult {
  value: DurableValue;
  encoded?: string;
}

/**
 * Copy a runtime value into the bounded durable-value contract.
 *
 * Property values are read only from data descriptors. Accessors and proxies are
 * rejected rather than observed, so validation cannot execute caller code.
 */
export function toDurableValue(value: unknown): DurableValue {
  return traverseDurableValue(value, false).value;
}

export function encodeDurableValue(value: unknown): string {
  return traverseDurableValue(value, true).encoded!;
}

export function decodeDurableValue(encoded: string): DurableValue {
  if (typeof encoded !== "string")
    throw new Error("Durable value encoding must be a string");
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > MAX_DURABLE_VALUE_BYTES) {
    throw new Error(
      `Durable value exceeds ${MAX_DURABLE_VALUE_BYTES} bytes at $`,
    );
  }
  return toDurableValue(JSON.parse(encoded));
}

function traverseDurableValue(
  value: unknown,
  collectEncoded: boolean,
): TraversalResult {
  const traversal = new DurableValueTraversal(collectEncoded);
  const durable = traversal.visit(value, 0);
  return { value: durable, encoded: traversal.encoded() };
}

class DurableValueTraversal {
  private readonly ancestors = new WeakSet<object>();
  private readonly chunks?: string[];
  private readonly path: PathSegment[] = [];
  private nodeCount = 0;
  private byteCount = 0;

  constructor(collectEncoded: boolean) {
    this.chunks = collectEncoded ? [] : undefined;
  }

  encoded(): string | undefined {
    return this.chunks?.join("");
  }

  visit(value: unknown, depth: number): DurableValue {
    this.consumeNode(depth);
    if (value === null) {
      this.append("null");
      return null;
    }
    if (typeof value === "boolean") {
      this.append(value ? "true" : "false");
      return value;
    }
    if (typeof value === "string") {
      this.appendString(value);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
        throw new Error(`Invalid durable number at ${this.formatPath()}`);
      }
      this.append(String(value));
      return value;
    }
    if (typeof value !== "object") {
      throw new Error(`Invalid durable value at ${this.formatPath()}`);
    }
    if (isProxy(value)) {
      throw new Error(`Proxy values are not durable at ${this.formatPath()}`);
    }
    if (Array.isArray(value)) return this.visitArray(value, depth);

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Only plain objects are durable at ${this.formatPath()}`);
    }
    return this.visitRecord(value as Record<string, unknown>, depth);
  }

  private visitArray(value: unknown[], depth: number): DurableValue[] {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error(`Only plain arrays are durable at ${this.formatPath()}`);
    }
    this.enter(value);
    try {
      this.reserveChildNodes(value.length);
      if (Object.getOwnPropertySymbols(value).length !== 0) {
        throw new Error(
          `Symbol-keyed properties are not durable at ${this.formatPath()}`,
        );
      }
      const propertyNames = Object.getOwnPropertyNames(value);
      for (const key of propertyNames) {
        if (key !== "length" && !isCanonicalArrayIndex(key, value.length)) {
          throw new Error(
            `Invalid array property ${JSON.stringify(key)} at ${this.formatPath()}`,
          );
        }
      }
      if (propertyNames.length !== value.length + 1) {
        throw new Error(
          `Sparse arrays are not durable at ${this.formatPath()}`,
        );
      }

      const output: DurableValue[] = [];
      this.append("[");
      for (let index = 0; index < value.length; index++) {
        if (index !== 0) this.append(",");
        this.path.push(index);
        try {
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          );
          if (descriptor === undefined) {
            throw new Error(
              `Sparse arrays are not durable at ${this.formatPath()}`,
            );
          }
          this.assertDataProperty(descriptor);
          output.push(this.visit(descriptor.value, depth + 1));
        } finally {
          this.path.pop();
        }
      }
      this.append("]");
      return output;
    } finally {
      this.ancestors.delete(value);
    }
  }

  private visitRecord(
    value: Record<string, unknown>,
    depth: number,
  ): { [key: string]: DurableValue } {
    this.enter(value);
    try {
      if (Object.getOwnPropertySymbols(value).length !== 0) {
        throw new Error(
          `Symbol-keyed properties are not durable at ${this.formatPath()}`,
        );
      }
      const keys = Object.getOwnPropertyNames(value).sort();
      this.reserveChildNodes(keys.length);
      const output: { [key: string]: DurableValue } = {};
      this.append("{");
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        if (!SAFE_KEY.test(key) || Object.hasOwn(UNSAFE_KEYS, key)) {
          throw new Error(
            `Invalid durable key ${JSON.stringify(key)} at ${this.formatPath()}`,
          );
        }
        if (index !== 0) this.append(",");
        this.path.push(key);
        try {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor === undefined) {
            throw new Error(
              `Durable object changed during validation at ${this.formatPath()}`,
            );
          }
          this.assertDataProperty(descriptor);
          this.appendString(key);
          this.append(":");
          const child = this.visit(descriptor.value, depth + 1);
          Object.defineProperty(output, key, {
            value: child,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        } finally {
          this.path.pop();
        }
      }
      this.append("}");
      return output;
    } finally {
      this.ancestors.delete(value);
    }
  }

  private consumeNode(depth: number): void {
    if (depth > MAX_DURABLE_VALUE_DEPTH) {
      throw new Error(
        `Durable value exceeds depth ${MAX_DURABLE_VALUE_DEPTH} at ${this.formatPath()}`,
      );
    }
    this.nodeCount++;
    if (this.nodeCount > MAX_DURABLE_VALUE_NODES) {
      throw new Error(
        `Durable value exceeds ${MAX_DURABLE_VALUE_NODES} nodes at ${this.formatPath()}`,
      );
    }
  }

  private reserveChildNodes(count: number): void {
    if (count > MAX_DURABLE_VALUE_NODES - this.nodeCount) {
      throw new Error(
        `Durable value exceeds ${MAX_DURABLE_VALUE_NODES} nodes at ${this.formatPath()}`,
      );
    }
  }

  private enter(value: object): void {
    if (this.ancestors.has(value)) {
      throw new Error(`Cyclic durable value at ${this.formatPath()}`);
    }
    this.ancestors.add(value);
  }

  private assertDataProperty(descriptor: PropertyDescriptor): void {
    if ("get" in descriptor || "set" in descriptor) {
      throw new Error(
        `Accessor properties are not durable at ${this.formatPath()}`,
      );
    }
    if (!descriptor.enumerable) {
      throw new Error(
        `Non-enumerable properties are not durable at ${this.formatPath()}`,
      );
    }
  }

  private appendString(value: string): void {
    const stringBytes = Buffer.byteLength(value, "utf8");
    if (stringBytes > MAX_DURABLE_STRING_BYTES) {
      throw new Error(
        `Durable string exceeds ${MAX_DURABLE_STRING_BYTES} bytes at ${this.formatPath()}`,
      );
    }
    this.append(JSON.stringify(value));
  }

  private append(text: string): void {
    const nextByteCount = this.byteCount + Buffer.byteLength(text, "utf8");
    if (nextByteCount > MAX_DURABLE_VALUE_BYTES) {
      throw new Error(
        `Durable value exceeds ${MAX_DURABLE_VALUE_BYTES} bytes at ${this.formatPath()}`,
      );
    }
    this.byteCount = nextByteCount;
    this.chunks?.push(text);
  }

  private formatPath(): string {
    let result = "$";
    for (const segment of this.path) {
      result +=
        typeof segment === "number"
          ? `[${segment}]`
          : `[${JSON.stringify(segment)}]`;
    }
    return result;
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}
