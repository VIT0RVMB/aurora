import { Match, Show, Switch } from "solid-js";
import * as sessions from "../state/sessions";
import { rightTab, showRight } from "../state/ui";
import { SearchPanel } from "./SearchPanel";
import { SessionsPanel } from "./SessionsPanel";

export function RightPanel() {
  return (
    <section class="right">
      <div class="panel-title right-tabs">
        <button classList={{ on: rightTab() === "sessions" }} onClick={() => showRight("sessions")}>
          sessões
          <Show when={sessions.waiting() > 0}>
            <span class="warn"> ◆{sessions.waiting()}</span>
          </Show>
        </button>
        <button classList={{ on: rightTab() === "search" }} onClick={() => showRight("search")}>
          busca
        </button>
      </div>
      <Switch>
        <Match when={rightTab() === "sessions"}>
          <SessionsPanel />
        </Match>
        <Match when={rightTab() === "search"}>
          <SearchPanel />
        </Match>
      </Switch>
    </section>
  );
}
