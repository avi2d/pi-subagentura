/** Structural security coverage for the branch preview release workflow. */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..");
const WORKFLOW_PATH = resolve(REPO, ".github/workflows/branch-release.yml");
const workflow = readFileSync(WORKFLOW_PATH, "utf-8");

function stepBlock(name: string): string {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, end === -1 ? undefined : end);
}

function runSource(step: string): string {
  const match = step.match(/\n        run: \|\n([\s\S]*)/);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

describe("branch release workflow (.github/workflows/branch-release.yml)", () => {
  it("keeps workflow expressions out of shell source and uses env inputs", () => {
    const resolveStep = stepBlock("Resolve release ref");
    const resolveRun = runSource(resolveStep);

    expect(resolveStep).toContain("INPUT_REF: ${{ inputs.ref }}");
    expect(resolveStep).toContain("DEFAULT_REF: ${{ github.ref_name }}");
    expect(resolveRun).not.toContain("${{");
    expect(resolveRun).toContain('raw_ref="$INPUT_REF"');
    expect(resolveRun).toContain('raw_ref="$DEFAULT_REF"');
    expect(resolveRun).toContain("printf 'ref<<%s\\n' \"$delimiter\"");
    expect(resolveRun).not.toContain('echo "ref=$raw_ref"');
  });

  it("does not embed expressions in any run step", () => {
    const runSources = [
      ...workflow.matchAll(
        /\n        run: \|\n([\s\S]*?)(?=\n      - name:|\n\s*$)/g,
      ),
    ].map((match) => match[1]);

    expect(runSources.length).toBeGreaterThan(0);
    expect(runSources.every((source) => !source.includes("${{"))).toBe(true);
  });

  it("passes release values through env and quotes shell variables", () => {
    const packStep = stepBlock("Pack release asset");
    const tagStep = stepBlock("Move branch release tag");
    const releaseStep = stepBlock("Create or update GitHub release");

    expect(packStep).toContain(
      "SHORT_SHA: ${{ steps.release_sha.outputs.short_sha }}",
    );
    expect(packStep).toContain(
      "SAFE_REF: ${{ steps.release_ref.outputs.safe_ref }}",
    );
    expect(runSource(packStep)).toContain('short_sha="$SHORT_SHA"');
    expect(runSource(packStep)).toContain(
      'asset="pi-subagentura-${SAFE_REF}-$short_sha.tgz"',
    );

    expect(tagStep).toContain(
      "RELEASE_TAG: ${{ steps.release_ref.outputs.tag }}",
    );
    expect(tagStep).toContain(
      "RELEASE_SHA: ${{ steps.release_sha.outputs.sha }}",
    );
    expect(runSource(tagStep)).toContain(
      'git tag -f "$RELEASE_TAG" "$RELEASE_SHA"',
    );

    expect(releaseStep).toContain(
      "RAW_REF: ${{ steps.release_ref.outputs.ref }}",
    );
    expect(releaseStep).toContain(
      "RELEASE_SHA: ${{ steps.release_sha.outputs.sha }}",
    );
    expect(runSource(releaseStep)).toContain(
      'gh release upload "$RELEASE_TAG"',
    );
  });

  it("preserves checkout of the resolved ref and release asset upload", () => {
    const checkoutStep = stepBlock("Checkout");
    const releaseStep = stepBlock("Create or update GitHub release");

    expect(checkoutStep).toContain("ref: ${{ steps.release_ref.outputs.ref }}");
    expect(releaseStep).toContain('gh release upload "$RELEASE_TAG"');
    expect(releaseStep).toContain('"dist/$ASSET" "dist/SHA256SUMS" --clobber');
  });
});
