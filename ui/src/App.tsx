import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { Confirm } from "./components/Confirm";
import { Editor } from "./components/Editor";
import { FileTree } from "./components/FileTree";
import { Palette } from "./components/Palette";
import { RightPanel } from "./components/RightPanel";
import { Splitter } from "./components/Splitter";
import { HintBar, StatusBar } from "./components/StatusBar";
import { TitleBar } from "./components/TitleBar";
import { Terminals } from "./components/Terminals";
import { Welcome } from "./components/Welcome";
import { measureCell } from "./lib/cells";
import { findCommand, isOutsidePath, parseCommand, type CommandSpec } from "./lib/commands";
import { core } from "./lib/ipc";
import { isEditable, isMac, isMod } from "./lib/platform";
import { parseSessionCommand, resolveSession, SUBCOMMANDS } from "./lib/sessions";
import { installVimKeys, LEADER_KEYS, type LeaderKey } from "./lib/vim";
import { KNOWN_AGENTS } from "./lib/agents";
import * as editor from "./state/editor";
import * as sessions from "./state/sessions";
import { setTheme } from "./state/theme";
import * as ui from "./state/ui";
import * as ws from "./state/workspace";

interface Command extends CommandSpec {
  run: (args: string[]) => Promise<string | void> | string | void;
}

async function pickFolder() {
  const dir = await openDialog({ directory: true, multiple: false });
  if (typeof dir === "string") await ws.openWorkspace(dir);
}

const commands: Command[] = [
  {
    name: "open",
    aliases: ["o", "e"],
    usage: "[pasta|arquivo]",
    description: "abre uma pasta (caminho absoluto ou ~) ou um arquivo do workspace",
    run: async ([path]) => {
      if (!path) return pickFolder();
      if (isOutsidePath(path)) return (await ws.openWorkspace(path)) ? undefined : "não foi possível abrir a pasta";
      if (!ws.workspace()) return "abra uma pasta antes";
      await editor.openFile(path.replace(/^\.\//, ""));
    },
  },
  {
    name: "theme",
    argChoices: ["dark", "light", "toggle"],
    description: "troca o tema",
    run: ([t = "toggle"]) => {
      if (t !== "dark" && t !== "light" && t !== "toggle") return `tema desconhecido: ${t}`;
      setTheme(t);
    },
  },
  {
    name: "session",
    aliases: ["s", "sess"],
    usage: "new <agente> [-w <worktree>] | kill | rename | rm | focus",
    description: "sessões de agente",
    complete: (before) => {
      if (before.length === 0) return [...SUBCOMMANDS];
      const sub = before[0];
      if (before.length === 1 && (sub === "new" || sub === "n")) return KNOWN_AGENTS;
      if (before.length === 1 && ["kill", "k", "rename", "mv", "rm", "remove", "close", "focus", "f", "go"].includes(sub)) {
        return sessions.here().map((x) => x.name);
      }
      if (before.length >= 2 && (sub === "new" || sub === "n")) return ["--worktree", "--name", "--"];
      return [];
    },
    run: async (args) => {
      const cmd = parseSessionCommand(args);
      if ("error" in cmd) return cmd.error;
      if (cmd.sub === "list") return void ui.showRight("sessions");
      if (cmd.sub === "new") return sessions.create({ agent: cmd.agent, name: cmd.name, worktree: cmd.worktree, args: cmd.args });
      const target = resolveSession(sessions.here(), cmd.target, sessions.activeSession());
      if (typeof target === "string") return target;
      switch (cmd.sub) {
        case "kill":
          return sessions.kill(target);
        case "rename":
          return sessions.rename(target, cmd.name);
        case "rm":
          return sessions.remove(target);
        case "focus":
          return sessions.focusSession(target.id);
      }
    },
  },
  {
    name: "split",
    aliases: ["vs", "vsplit"],
    description: "divide os terminais: a sessão ativa vai para um painel novo",
    run: () => sessions.split(),
  },
  {
    name: "unsplit",
    aliases: ["only"],
    description: "junta todos os painéis de terminal em um",
    run: () => sessions.unsplit(),
  },
  {
    name: "write",
    aliases: ["w"],
    description: "salva o arquivo atual",
    run: () => editor.saveFile(),
  },
  {
    name: "wq",
    aliases: ["x"],
    description: "salva e fecha o arquivo atual",
    run: async () => {
      await editor.saveFile();
      editor.closeTab();
    },
  },
  {
    name: "quit",
    aliases: ["q", "close"],
    usage: "[!]",
    description: "fecha a aba atual (:q! descarta alterações)",
    run: ([bang]) => closeCurrent(bang === "!"),
  },
  {
    name: "qall",
    aliases: ["qa", "quitall"],
    usage: "[!]",
    description: "fecha o app; as sessões continuam no sessiond (:qa! descarta alterações)",
    run: ([bang]) => {
      if (editor.hasDirtyTabs() && bang !== "!") return "há arquivos não salvos: salve ou use :qa!";
      void core.quit();
    },
  },
  {
    name: "vim",
    argChoices: ["on", "off"],
    description: "liga ou desliga os atalhos do vim no editor",
    run: ([v]) => editor.setVim(v ? v === "on" : !editor.vimEnabled()),
  },
];

/** `:q` closes what you are looking at: the terminal tab or the file. */
function closeCurrent(force: boolean): string | void {
  if (ui.area() === "terminal") return sessions.hideTab();
  const tab = editor.activeTab();
  if (!tab) return sessions.activeSession() ? sessions.hideTab() : "nada para fechar (:qa fecha o app)";
  if (tab.dirty && !force) return `${tab.name} tem alterações não salvas: :w ou :q!`;
  editor.closeTab(tab.path, true);
}

function leader(k: LeaderKey) {
  switch (k) {
    case "f":
      return ui.openPalette("files");
    case "p":
      return ui.openPalette("command");
    case "/":
      ui.showRight("search");
      return ui.setSearchFocus((n) => n + 1);
    case "s":
      return ui.showRight("sessions");
    case "t":
      return sessions.toggleArea();
    case "e":
      ui.toggleTree(true);
      return ui.setTreeFocus((n) => n + 1);
    case "b":
      return ui.toggleTree();
    case "n":
      return ui.openPalette("command", ":session new ");
    case "w":
      return void editor.saveFile();
    case "q":
      return void Promise.resolve(closeCurrent(false)).then((e) => e && ui.notify(e, "warn"));
  }
}

async function runLine(line: string): Promise<string | void> {
  const parsed = parseCommand(line);
  if (!parsed) return;
  // `:q!` is one token; treat a trailing bang as an argument.
  let { name, args } = parsed;
  if (name.endsWith("!")) {
    name = name.slice(0, -1);
    args = ["!", ...args];
  }
  const cmd = findCommand(commands, name);
  if (cmd) return cmd.run(args);
  // Not ours: let vim try (`:%s/a/b/g`, `:42`, `:noh`).
  if (editor.vimEx(line)) return;
  return `comando desconhecido: ${name}`;
}

export function App() {
  const [cell, setCell] = createSignal({ w: 8, h: 20 });

  // Global keys. Capture phase so they win over CodeMirror's own bindings.
  const onKey = (e: KeyboardEvent) => {
    const mod = isMod(e);
    const k = e.key.toLowerCase();
    const inTerm = !!(document.activeElement as HTMLElement | null)?.closest?.(".term-host");
    // Off macOS, Ctrl+letter belongs to the shell (Ctrl+P, Ctrl+W, Ctrl+B…);
    // inside a terminal only Ctrl+Shift shortcuts reach the app.
    if (inTerm && !isMac && mod && !e.shiftKey && k !== "tab") return;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (mod && e.shiftKey && k === "p") return handled(), ui.openPalette("command");
    if (mod && !e.shiftKey && k === "p") return handled(), ui.openPalette("files");
    if (mod && e.shiftKey && k === "f") {
      handled();
      ui.showRight("search");
      ui.setSearchFocus((n) => n + 1);
      return;
    }
    if (mod && e.shiftKey && k === "a") return handled(), ui.showRight("sessions");
    if (mod && !e.shiftKey && k === "j") return handled(), sessions.toggleArea();
    if (mod && !e.shiftKey && (e.key === "\\" || e.code === "Backslash")) {
      handled();
      const err = sessions.split();
      if (err) ui.notify(err, "warn");
      return;
    }
    if (mod && !e.shiftKey && k === "s") return handled(), void editor.saveFile();
    if (mod && !e.shiftKey && k === "w") return handled(), inTerm ? sessions.hideTab() : editor.closeTab();
    if (mod && !e.shiftKey && k === "b") return handled(), ui.toggleTree();
    if (mod && e.shiftKey && k === "b") return handled(), ui.toggleRight();
    if (mod && e.shiftKey && k === "e") {
      handled();
      ui.toggleTree(true);
      ui.setTreeFocus((n) => n + 1);
      return;
    }
    if (mod && k === "o") return handled(), void pickFolder();
    if (e.ctrlKey && k === "tab") {
      handled();
      return inTerm ? sessions.cycleTab(e.shiftKey ? -1 : 1) : editor.cycleTab(e.shiftKey ? -1 : 1);
    }
    const bare = !mod && !e.altKey && !e.ctrlKey && !ui.palette() && !ui.confirmation();
    const free = bare && !isEditable(document.activeElement);
    // In vim's normal mode the editor is not taking text, so the leader applies.
    const vimNormal = bare && ui.area() === "editor" && editor.vimEnabled() && editor.vimMode() === "normal";
    if (leaderPending) {
      leaderPending = false;
      if ((LEADER_KEYS as readonly string[]).includes(e.key)) return handled(), leader(e.key as LeaderKey);
    }
    if (e.key === " " && (free || vimNormal)) {
      handled();
      leaderPending = true;
      return;
    }
    if (e.key === ":" && free) {
      return handled(), ui.openPalette("command");
    }
  };
  let leaderPending = false;
  const onFocus = (e: FocusEvent) => ui.setArea(ui.areaOf(e.target as Element));

  onMount(async () => {
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("focusin", onFocus);
    installVimKeys({ palette: () => ui.openPalette("command") });
    setCell(measureCell());
    await document.fonts?.ready;
    setCell(measureCell());

    const unlisten = await core.onFsChange((b) => {
      ws.applyFsBatch(b);
      void editor.applyFsBatch(b);
    });
    onCleanup(unlisten);

    await sessions.init();
    const start = (await core.initialPath()) ?? ws.recent()[0];
    if (start) await ws.openWorkspace(start);
  });

  // Each workspace has its own sessions and pane layout.
  createEffect(on(() => ws.workspace()?.root, (root) => root && void sessions.refresh()));
  onCleanup(() => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("focusin", onFocus);
  });

  createEffect(() => {
    const name = ws.workspace()?.name;
    const tab = editor.activeTab();
    const waiting = sessions.waiting();
    const title = [
      waiting ? `◆${waiting}` : null,
      tab ? `${tab.name}${tab.dirty ? " +" : ""}` : null,
      name,
      "aurora",
    ]
      .filter(Boolean)
      .join(" — ");
    void getCurrentWindow().setTitle(title).catch(() => {});
  });

  const columns = () =>
    [
      ui.treeVisible() && ws.workspace() ? `calc(${ui.treeCells()} * var(--cell-w)) 1px` : "",
      "minmax(0, 1fr)",
      ui.rightVisible() && ws.workspace() ? `1px calc(${ui.rightCells()} * var(--cell-w))` : "",
    ]
      .filter(Boolean)
      .join(" ");

  return (
    <div class="app">
      <TitleBar />
      <Show when={ws.workspace()} fallback={<Welcome onOpen={() => void pickFolder()} />}>
        <main class="layout" style={{ "grid-template-columns": columns() }}>
          <Show when={ui.treeVisible()}>
            <FileTree rowH={() => cell().h} />
            <Splitter
              cells={ui.treeCells}
              setCells={ui.setTreeCells}
              cellW={() => cell().w}
              min={16}
              max={80}
              direction={1}
              onEnd={ui.persistSizes}
            />
          </Show>
          <Center cellH={() => cell().h} />
          <Show when={ui.rightVisible()}>
            <Splitter
              cells={ui.rightCells}
              setCells={ui.setRightCells}
              cellW={() => cell().w}
              min={24}
              max={120}
              direction={-1}
              onEnd={ui.persistSizes}
            />
            <RightPanel />
          </Show>
        </main>
      </Show>
      <StatusBar />
      <HintBar />
      <Show when={ui.palette()} keyed>
        <Palette commands={commands} run={runLine} />
      </Show>
      <Show when={ui.confirmation()} keyed>
        {(req) => <Confirm req={req} />}
      </Show>
    </div>
  );
}

/** Editor on top, terminals below; either takes the whole column alone. */
function Center(p: { cellH: () => number }) {
  const terms = () => ui.terminalVisible() && sessions.hasTabs();
  const edit = () => editor.tabs.length > 0 || !terms();
  const both = () => terms() && edit();
  const rows = () =>
    [
      edit() ? "minmax(0, 1fr)" : "0",
      both() ? "1px" : "0",
      terms() ? (both() ? `calc(${ui.terminalRows()} * var(--cell-h))` : "minmax(0, 1fr)") : "0",
    ].join(" ");
  return (
    <section class="center" style={{ "grid-template-rows": rows() }}>
      <div class="center-slot" classList={{ hidden: !edit() }}>
        <Editor />
      </div>
      <Show when={both()} fallback={<div />}>
        <Splitter
          axis="y"
          cells={ui.terminalRows}
          setCells={ui.setTerminalRows}
          cellW={p.cellH}
          min={4}
          max={80}
          direction={-1}
          onEnd={ui.persistSizes}
        />
      </Show>
      <div class="center-slot" classList={{ hidden: !terms() }}>
        <Terminals />
      </div>
    </section>
  );
}
