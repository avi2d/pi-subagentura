import {
  DynamicBorder,
  getSelectListTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  SelectList,
  Spacer,
  Text,
  type SelectItem,
} from "@earendil-works/pi-tui";

export interface WorkflowPickerChoice {
  name: string;
  description: string;
}

export type WorkflowPickerAction =
  | { kind: "run"; name: string }
  | { kind: "delete"; name: string }
  | { kind: "cancel" };

export class WorkflowPickerComponent extends Container {
  private readonly selectList: SelectList;
  private readonly done: (action: WorkflowPickerAction) => void;

  constructor(
    choices: WorkflowPickerChoice[],
    theme: Theme,
    done: (action: WorkflowPickerAction) => void,
  ) {
    super();
    this.done = done;

    const items: SelectItem[] = choices.map((choice) => ({
      value: choice.name,
      label: choice.name,
      description: choice.description || "(no description)",
    }));

    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(theme.fg("accent", theme.bold("Select workflow:")), 1, 0),
    );
    this.addChild(new Spacer(1));

    this.selectList = new SelectList(
      items,
      Math.min(items.length, 10),
      getSelectListTheme(),
    );
    this.selectList.onSelect = (item) =>
      this.done({ kind: "run", name: item.value });
    this.selectList.onCancel = () => this.done({ kind: "cancel" });
    this.addChild(this.selectList);

    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        theme.fg(
          "muted",
          "↑↓ navigate  d delete  enter select  escape/ctrl+c cancel",
        ),
        1,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
  }

  handleInput(data: string): void {
    if (data === "d") {
      const selected = this.selectList.getSelectedItem();
      if (selected) this.done({ kind: "delete", name: selected.value });
      return;
    }
    const normalized = data === "j" ? "\x1b[B" : data === "k" ? "\x1b[A" : data;
    this.selectList.handleInput(normalized);
  }
}
