import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { Confirm } from "./components/Confirm";
import { Editor } from "./components/Editor";
import { FileTree } from "./components/FileTree";
import { Palette } from "./components/Palette";
import { Prefs } from "./components/Prefs";
import { RightPanel } from "./components/RightPanel";
import { Splitter } from "./components/Splitter";
import { HintBar, StatusBar } from "./components/StatusBar";
import { TitleBar } from "./components/TitleBar";
import { Terminals } from "./components/Terminals";
import { Welcome } from "./components/Welcome";
import { measureCell } from "./lib/cells";
import { findCommand, isOutsidePath, parseCommand, type CommandSpec } from "./lib/commands";
import { core } from "./lib/ipc";
import type { Dir } from "./lib/panes";
import { isEditable, isMac, isMod } from "./lib/platform";
import { displayName, parseSessionCommand, resolveSession, STAGES, SUBCOMMANDS } from "./lib/sessions";
import { installVimKeys, LEADER_KEYS, type LeaderKey } from "./lib/vim";
import { KNOWN_AGENTS } from "./lib/agents";
import * as editor from "./state/editor";
import * as sessions from "./state/sessions";
import { fontKey } from "./state/prefs";
import { refreshThemes, setTheme, themes, themesDir } from "./state/theme";
import * as ui from "./state/ui";
import * as ws from "./state/workspace";
import { LOCALES, locale, parseLocale, setLocale, t, type Key } from "./lib/i18n";

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
    get usage() {
      return t("cmd.open.usage");
    },
    get description() {
      return t("cmd.open.desc");
    },
    run: async ([path]) => {
      if (!path) return pickFolder();
      if (isOutsidePath(path)) return (await ws.openWorkspace(path)) ? undefined : t("err.openFolder");
      if (!ws.workspace()) return t("err.openFolderFirst");
      await editor.openFile(path.replace(/^\.\//, ""));
    },
  },
  {
    name: "theme",
    get usage() {
      return t("cmd.theme.usage");
    },
    get description() {
      return t("cmd.theme.desc");
    },
    complete: (before) =>
      before.length === 0
        ? [
            { value: "dark", description: `Phosphor · ${t("theme.dark")}` },
            { value: "light", description: `Aurora Light · ${t("theme.light")}` },
            { value: "toggle", description: t("theme.toggle") },
            { value: "dir", description: t("theme.dir") },
            ...themes().map((th) => ({ value: th.id, description: `${th.name} · ${t(th.variant === "dark" ? "theme.dark" : "theme.light")}` })),
          ]
        : [],
    run: async ([id = "toggle"]) => {
      if (id === "dir") {
        await refreshThemes();
        return void ui.notify(t("theme.found", { dir: themesDir(), n: themes().length }));
      }
      const err = await setTheme(id);
      void refreshThemes();
      return err ?? undefined;
    },
  },
  {
    name: "session",
    aliases: ["s", "sess"],
    get usage() {
      return t("cmd.session.usage");
    },
    get description() {
      return t("cmd.session.desc");
    },
    complete: (before) => {
      if (before.length === 0) return [...SUBCOMMANDS];
      const sub = before[0];
      if (before.length === 1 && (sub === "new" || sub === "n")) return KNOWN_AGENTS;
      if (before.length === 1 && ["kill", "k", "rename", "mv", "rm", "remove", "close", "focus", "f", "go"].includes(sub)) {
        return sessions.here().map((x) => x.name);
      }
      if (before.length >= 2 && (sub === "new" || sub === "n")) return ["--worktree", "--name", "--"];
      if (sub === "stage" || sub === "st") {
        if (before.length === 1) return STAGES.map((st) => ({ value: st, description: t(`stage.${st}` as Key) }));
        if (before.length === 2) return sessions.here().map((x) => x.name);
      }
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
        case "stage": {
          const err = await sessions.setStage(target, cmd.stage);
          if (err) return err;
          return void ui.notify(t("sess.staged", { name: displayName(target), stage: t(`stage.${cmd.stage}` as Key) }));
        }
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
    name: "home",
    get description() {
      return t("cmd.home.desc");
    },
    run: () => void ui.setCenterView("home"),
  },
  {
    name: "kanban",
    aliases: ["board", "kb"],
    get description() {
      return t("cmd.kanban.desc");
    },
    run: () => void ui.setCenterView("kanban"),
  },
  {
    name: "prefs",
    aliases: ["preferences", "settings", "font"],
    get description() {
      return t("cmd.prefs.desc");
    },
    run: () => void ui.setPrefsOpen(true),
  },
  {
    name: "tree",
    aliases: ["files"],
    usage: "[show|hide]",
    argChoices: ["show", "hide"],
    get description() {
      return t("cmd.tree.desc");
    },
    run: ([v]) => ui.toggleTree(v === "show" ? true : v === "hide" ? false : undefined),
  },
  {
    name: "panel",
    usage: "[show|hide]",
    argChoices: ["show", "hide"],
    get description() {
      return t("cmd.panel.desc");
    },
    run: ([v]) => ui.toggleRight(v === "show" ? true : v === "hide" ? false : undefined),
  },
  {
    name: "split",
    aliases: ["vs", "vsplit"],
    usage: "[right|down]",
    argChoices: ["right", "down"],
    get description() {
      return t("cmd.split.desc");
    },
    run: ([d]) => split(d === "down" ? "column" : "row"),
  },
  {
    name: "hsplit",
    aliases: ["sp"],
    get description() {
      return t("cmd.hsplit.desc");
    },
    run: () => split("column"),
  },
  {
    name: "unsplit",
    aliases: ["only"],
    get description() {
      return t("cmd.unsplit.desc");
    },
    run: () => (ui.workArea() === "terminal" ? sessions.unsplit() : editor.unsplit()),
  },
  {
    name: "write",
    aliases: ["w"],
    get description() {
      return t("cmd.write.desc");
    },
    run: () => editor.saveFile(),
  },
  {
    name: "wq",
    aliases: ["x"],
    get description() {
      return t("cmd.wq.desc");
    },
    run: async () => {
      await editor.saveFile();
      editor.closeTab();
    },
  },
  {
    name: "quit",
    aliases: ["q", "close"],
    usage: "[!]",
    get description() {
      return t("cmd.quit.desc");
    },
    run: ([bang]) => closeCurrent(bang === "!"),
  },
  {
    name: "qall",
    aliases: ["qa", "quitall"],
    usage: "[!]",
    get description() {
      return t("cmd.qall.desc");
    },
    run: ([bang]) => {
      if (editor.hasDirtyTabs() && bang !== "!") return t("err.unsavedQuit");
      void core.quit();
    },
  },
  {
    name: "vim",
    argChoices: ["on", "off"],
    get description() {
      return t("cmd.vim.desc");
    },
    run: ([v]) => editor.setVim(v ? v === "on" : !editor.vimEnabled()),
  },
  {
    name: "lang",
    aliases: ["language", "idioma"],
    usage: "[en|pt-BR]",
    argChoices: LOCALES.map((l) => l.id),
    get description() {
      return t("cmd.lang.desc");
    },
    run: ([v]) => {
      if (!v) return void setLocale(locale() === "en" ? "pt-BR" : "en");
      const l = parseLocale(v);
      if (!l) return t("err.unknownLocale", { name: v });
      setLocale(l);
    },
  },
];

/** `:q` closes what you are looking at: the terminal tab or the file. */
/** Splits whichever of editor and terminals was used last. */
function split(dir: Dir): string | void {
  if (ui.workArea() === "terminal" && sessions.hasTabs()) return sessions.split(dir);
  editor.split(dir);
}

function closeCurrent(force: boolean): string | void {
  if (ui.area() === "terminal") return sessions.hideTab();
  if (editor.closeEmptyGroup()) return;
  const tab = editor.activeTab();
  if (!tab) return sessions.activeSession() ? sessions.hideTab() : t("err.nothingToClose");
  if (tab.dirty && !force) return t("err.tabDirty", { name: tab.name });
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
    case "h":
      return ui.setCenterView("home");
    case "k":
      return ui.setCenterView("kanban");
    case "o":
      return ui.workArea() === "terminal" ? sessions.focusNextPane() : editor.focusNextGroup();
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
  return t("err.unknownCommand", { name });
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
    if (mod && (e.key === "\\" || e.key === "|" || e.code === "Backslash")) {
      handled();
      const err = split(e.shiftKey ? "column" : "row");
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
    if (mod && !e.shiftKey && e.key === ",") return handled(), ui.setPrefsOpen(true);
    if (e.ctrlKey && k === "tab") {
      handled();
      return inTerm ? sessions.cycleTab(e.shiftKey ? -1 : 1) : editor.cycleTab(e.shiftKey ? -1 : 1);
    }
    const bare = !mod && !e.altKey && !e.ctrlKey && !ui.palette() && !ui.confirmation() && !ui.prefsOpen();
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
  // A new font changes the cell: re-measure once it has loaded.
  createEffect(
    on(fontKey, () => void document.fonts?.ready.then(() => requestAnimationFrame(() => setCell(measureCell()))), {
      defer: true,
    }),
  );
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
      <Show when={ui.prefsOpen()}>
        <Prefs />
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
  // A view asked for (`:home`, `:kanban`) claims the editor area even with no file.
  const edit = () => editor.tabs.length > 0 || ui.centerView() !== "auto" || !terms();
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
