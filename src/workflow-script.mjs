import { runInNewContext } from "node:vm";

/**
 * Split a workflow script into its static `meta` literal and the executable body.
 */
export function parseWorkflow(script) {
  const metaRe = /(^|\n)\s*export\s+const\s+meta\s*=\s*/;
  const m = metaRe.exec(script);
  if (!m) {
    throw new Error(
      "Workflow script must declare `export const meta = { name, description }` as a pure literal.",
    );
  }
  const braceStart = script.indexOf("{", m.index + m[0].length);
  if (braceStart === -1) {
    throw new Error(
      "`export const meta` must be assigned an object literal `{ ... }`.",
    );
  }
  const braceEnd = matchBrace(script, braceStart);
  const metaText = script.slice(braceStart, braceEnd + 1);

  let meta;
  try {
    const sandbox = Object.assign(Object.create(null), {
      Date: makeGuardedDate(),
      Math: makeGuardedMath(),
    });
    meta = runInNewContext(`(${metaText})`, sandbox, {
      contextCodeGeneration: { strings: false, wasm: false },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Workflow \`meta\` must be a pure literal (no variables/calls). Eval failed: ${msg}`,
    );
  }
  if (!meta || typeof meta !== "object") {
    throw new Error("Workflow `meta` did not evaluate to an object.");
  }
  if (typeof meta.name !== "string" || !meta.name) {
    throw new Error("Workflow `meta.name` must be a non-empty string.");
  }
  if (typeof meta.description !== "string" || !meta.description) {
    throw new Error("Workflow `meta.description` must be a non-empty string.");
  }

  let trailing = braceEnd + 1;
  if (script[trailing] === ";") trailing++;
  const body = (script.slice(0, m.index) + script.slice(trailing))
    .replace(/(^|\n)\s*export\s+default\s+/g, "$1")
    .replace(/(^|\n)\s*export\s+/g, "$1");
  return { meta, body };
}

function matchBrace(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error("Unbalanced braces in `export const meta` literal.");
}

function skipString(src, start) {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return src.length;
}

export function makeGuardedDate() {
  const Guard = function (...a) {
    if (a.length === 0) {
      throw new Error(
        "`new Date()` with no args is non-deterministic and unavailable in workflows. Pass a timestamp via `args`.",
      );
    }
    return new Date(...a);
  };
  Guard.now = () => {
    throw new Error(
      "`Date.now()` is non-deterministic and unavailable in workflows. Pass a timestamp via `args`.",
    );
  };
  Guard.parse = Date.parse;
  Guard.UTC = Date.UTC;
  // Don't set Guard.prototype = Date.prototype — that leaks host constructors
  // via Date.prototype.constructor → Function. Use a null-prototype object instead.
  Guard.prototype = Object.create(null);
  Guard.prototype.constructor = Guard;
  return Guard;
}

export function makeGuardedMath() {
  // Copy all Math properties onto a null-prototype object so the constructor
  // chain doesn't lead back to host Function via Math.constructor → Object → Function.
  const safe = Object.create(null);
  for (const key of Object.getOwnPropertyNames(Math)) {
    if (key === "random") {
      safe.random = () => {
        throw new Error(
          "`Math.random()` is non-deterministic and unavailable in workflows. Vary by index instead.",
        );
      };
    } else {
      const val = Math[key];
      safe[key] = typeof val === "function" ? val.bind(Math) : val;
    }
  }
  return safe;
}

export function workflowStringify(x) {
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}
