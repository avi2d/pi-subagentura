import { runInNewContext } from "node:vm";

/** Split a workflow script into its static `meta` literal and executable body. */
const META_EVAL_TIMEOUT_MS = 100;

export function parseWorkflow(script) {
  const tokens = scanTopLevelTokens(script);
  let metaTokenIndex = -1;
  let braceStart = -1;

  for (let i = 0; i < tokens.length - 4; i++) {
    if (
      tokens[i].value === "export" &&
      tokens[i + 1].value === "const" &&
      tokens[i + 2].value === "meta" &&
      tokens[i + 3].value === "="
    ) {
      metaTokenIndex = i;
      braceStart = tokens[i + 4].value === "{" ? tokens[i + 4].start : -1;
      break;
    }
  }
  if (metaTokenIndex === -1) {
    throw new Error(
      "Workflow script must declare `export const meta = { name, description }` as a pure literal.",
    );
  }
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
      timeout: META_EVAL_TIMEOUT_MS,
      microtaskMode: "afterEvaluate",
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

  let metaEnd = braceEnd + 1;
  if (script[metaEnd] === ";") metaEnd++;
  const body = stripWorkflowExports(script, tokens, metaTokenIndex, metaEnd);
  return { meta, body };
}

const CONTROL_HEADER_KEYWORDS = new Set([
  "if",
  "while",
  "for",
  "with",
  "switch",
  "catch",
]);

function scanTopLevelTokens(src) {
  const tokens = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let previousToken = "";
  const parenContexts = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(src, i);
      previousToken = "string";
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      previousToken = "template";
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i = skipLineComment(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = skipBlockComment(src, i);
      continue;
    }
    if (c === "/" && isRegexStart(previousToken)) {
      i = skipRegex(src, i);
      previousToken = "regex";
      continue;
    }

    const identifier = readIdentifier(src, i);
    if (identifier) {
      if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
        tokens.push(identifier);
      }
      previousToken = identifier.value;
      i = identifier.end;
      continue;
    }

    const token = { value: c, start: i, end: i + 1 };
    if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      tokens.push(token);
    }
    const nextPreviousToken = punctuatorToken(c, previousToken, parenContexts);
    if (c === "{") braceDepth++;
    else if (c === "}") braceDepth--;
    else if (c === "(") parenDepth++;
    else if (c === ")") parenDepth--;
    else if (c === "[") bracketDepth++;
    else if (c === "]") bracketDepth--;
    previousToken = nextPreviousToken;
    i++;
  }
  return tokens;
}

function stripWorkflowExports(src, tokens, metaTokenIndex, metaEnd) {
  const ranges = [{ start: tokens[metaTokenIndex].start, end: metaEnd }];
  for (let i = 0; i < tokens.length; i++) {
    if (i === metaTokenIndex || tokens[i].value !== "export") continue;
    let end = tokens[i].end;
    if (tokens[i + 1]?.value === "default") end = tokens[i + 1].end;
    ranges.push({ start: tokens[i].start, end });
  }
  ranges.sort((a, b) => a.start - b.start);
  let body = "";
  let cursor = 0;
  for (const range of ranges) {
    body += src.slice(cursor, range.start);
    cursor = range.end;
  }
  return body + src.slice(cursor);
}

function readIdentifier(src, start) {
  if (!/[A-Za-z_$]/.test(src[start])) return null;
  let end = start + 1;
  while (end < src.length && /[A-Za-z0-9_$]/.test(src[end])) end++;
  return { value: src.slice(start, end), start, end };
}

function punctuatorToken(token, previousToken, parenContexts) {
  if (token === "(") {
    parenContexts.push(CONTROL_HEADER_KEYWORDS.has(previousToken));
  } else if (token === ")") {
    return parenContexts.pop() ? "control-close" : token;
  }
  return token;
}

function isRegexStart(previousToken) {
  return (
    !previousToken ||
    new Set([
      "(",
      "control-close",
      "=",
      "[",
      "{",
      ",",
      ":",
      ";",
      "!",
      "?",
      "+",
      "-",
      "*",
      "%",
      "&",
      "|",
      "~",
      ">",
      "return",
      "throw",
      "case",
      "delete",
      "void",
      "typeof",
      "new",
      "in",
      "instanceof",
      "else",
      "do",
    ]).has(previousToken)
  );
}

function matchBrace(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  let previousToken = "";
  const parenContexts = [];
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = skipString(src, i);
      previousToken = "string";
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      previousToken = "template";
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i = skipLineComment(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = skipBlockComment(src, i);
      continue;
    }
    if (c === "/" && isRegexStart(previousToken)) {
      i = skipRegex(src, i);
      previousToken = "regex";
      continue;
    }
    const identifier = readIdentifier(src, i);
    if (identifier) {
      previousToken = identifier.value;
      i = identifier.end;
      continue;
    }
    const nextPreviousToken = punctuatorToken(c, previousToken, parenContexts);
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    previousToken = nextPreviousToken;
    i++;
  }
  throw new Error("Unbalanced braces in `export const meta` literal.");
}

function skipTemplate(src, start) {
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === "`") return i + 1;
    if (src[i] === "$" && src[i + 1] === "{") {
      i = skipTemplateExpression(src, i + 2);
      continue;
    }
    i++;
  }
  return src.length;
}

function skipTemplateExpression(src, start) {
  let depth = 1;
  let i = start;
  let previousToken = "";
  const parenContexts = [];
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(src, i);
      previousToken = "string";
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      previousToken = "template";
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i = skipLineComment(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = skipBlockComment(src, i);
      continue;
    }
    if (c === "/" && isRegexStart(previousToken)) {
      i = skipRegex(src, i);
      previousToken = "regex";
      continue;
    }
    const identifier = readIdentifier(src, i);
    if (identifier) {
      previousToken = identifier.value;
      i = identifier.end;
      continue;
    }
    const nextPreviousToken = punctuatorToken(c, previousToken, parenContexts);
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    previousToken = nextPreviousToken;
    i++;
  }
  return src.length;
}

function skipLineComment(src, start) {
  const newline = src.indexOf("\n", start + 2);
  return newline === -1 ? src.length : newline;
}

function skipBlockComment(src, start) {
  const end = src.indexOf("*/", start + 2);
  return end === -1 ? src.length : end + 2;
}

function skipRegex(src, start) {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      i++;
      while (/[A-Za-z]/.test(src[i])) i++;
      return i;
    }
    i++;
  }
  return src.length;
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
