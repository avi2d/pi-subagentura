export interface TerminalHarnessOptions {
  scenario?: string;
  keep?: boolean;
}
export interface PaneInfo {
  id: string;
  pid: number;
  session: string;
  window: string;
  pane: string;
  active: boolean;
  command: string;
}
export interface TmuxVersion {
  text: string;
  major: number;
  minor: number;
}
export class TerminalHarness {
  constructor(options?: TerminalHarnessOptions);
  scenario: string;
  readonly root: string;
  readonly session: string;
  readonly socket: string;
  readonly workspace: string;
  readonly gates: string;
  readonly providerLog: string;
  readonly networkLog: string;
  readonly parentPane: string | undefined;
  readonly version: TmuxVersion;
  readonly env: Record<string, string>;
  setupFiles(): void;
  tmux(
    args: string[],
    options?: { timeout?: number; stdio?: ["ignore", "pipe", "pipe"] },
  ): string;
  start(): Promise<this>;
  sendText(text: string): void;
  sendKey(key: string): void;
  pressEnter(): void;
  currentScreen(pane?: string): string;
  scrollback(pane?: string): string;
  panes(): PaneInfo[];
  providerEvents(): Array<Record<string, unknown>>;
  networkEvents(): Array<Record<string, unknown>>;
  artifactEvents(): Array<Record<string, unknown>>;
  release(name: string): void;
  waitFor(
    predicate: () => boolean | Promise<boolean>,
    description: string,
    timeoutMs?: number,
  ): Promise<void>;
  waitForScreen(
    predicate: (screen: string) => boolean,
    description: string,
    timeoutMs?: number,
  ): Promise<void>;
  waitForProvider(
    predicate: (events: Array<Record<string, unknown>>) => boolean,
    description: string,
    timeoutMs?: number,
  ): Promise<void>;
  assertNoNetwork(): Promise<void>;
  diagnostics(): void;
  cleanup(failed?: boolean): Promise<void>;
}
export function createHarness(
  options?: TerminalHarnessOptions,
): TerminalHarness;
export const REPO: string;
