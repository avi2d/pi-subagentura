import { describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  WorkflowPickerComponent,
  type WorkflowPickerAction,
} from "../src/workflow-picker-ui";

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

initTheme("dark", false);

describe("WorkflowPickerComponent", () => {
  it("deletes the selected workflow when d is pressed", () => {
    const done = vi.fn<(action: WorkflowPickerAction) => void>();
    const component = new WorkflowPickerComponent(
      [
        { name: "first", description: "First workflow" },
        { name: "second", description: "Second workflow" },
      ],
      theme as any,
      done,
    );

    component.handleInput("j");
    component.handleInput("d");

    expect(done).toHaveBeenCalledWith({ kind: "delete", name: "second" });
  });

  it("advertises the delete shortcut", () => {
    const component = new WorkflowPickerComponent(
      [{ name: "first", description: "First workflow" }],
      theme as any,
      vi.fn(),
    );

    expect(component.render(80).join("\n")).toContain("d delete");
  });
});
