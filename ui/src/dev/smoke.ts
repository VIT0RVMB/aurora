// Dev-only end-to-end check through the real core and sessiond
// (`AURORA_SMOKE=1 pnpm dev -- -- <folder>`). Run it twice:
// the first run starts a session and quits with it alive; the second finds
// it again, checks the history survived, and removes it.
import { invoke } from "@tauri-apps/api/core";
import { core } from "../lib/ipc";
import * as sessions from "../state/sessions";
import * as ui from "../state/ui";
import { workspace } from "../state/workspace";

const log = (msg: string) => invoke("dev_log", { msg });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
}

/** `AURORA_SMOKE=claude`: a real Claude session typed through xterm.js. */
async function claudeSmoke() {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const err = await sessions.create({ agent: "claude", name: "smoke-claude" });
  if (err) throw new Error(err);
  const s = sessions.here().find((x) => x.name === "smoke-claude")!;
  const term = await sessions.terminal(s.id);
  await until("terminal opened", () => term.opened);
  await sleep(6000);
  await log(`${ms()} ms ready? title=${sessions.byId(s.id)?.title}`);
  for (const ch of "Responda apenas com a palavra ok.") {
    term.type(ch);
    await sleep(30);
  }
  await sleep(300);
  term.type("\r");
  await log(`${ms()} ms prompt sent`);
  let last = "";
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    const info = sessions.byId(s.id);
    const now = `${info?.status} ${info?.title}`;
    if (now !== last) await log(`${ms()} ms ${(last = now)}`);
    if (info?.status === "done") break;
    await sleep(250);
  }
  const tail = term.text().split("\n").filter((l) => l.trim()).slice(-25).join("\n");
  await log(`--- terminal ---\n${tail}`);
  await core.sessionRemove(s.id, false, false);
}

/** `AURORA_SMOKE=size`: does the PTY get the size xterm shows, also after a resize? */
async function sizeSmoke() {
  const err = await sessions.create({ agent: "shell", name: "smoke-size" });
  if (err) throw new Error(err);
  const s = sessions.here().find((x) => x.name === "smoke-size")!;
  const term = await sessions.terminal(s.id);
  await until("terminal opened", () => term.opened);
  await sleep(1500);
  const probe = async (label: string) => {
    const mark = `SZ${Math.random().toString(36).slice(2, 7)}`;
    await core.sessionInput(s.id, `echo ${mark} $(stty size)\r`);
    await until("stty", () => new RegExp(`${mark} \\d+ \\d+`).test(term.text()));
    const m = new RegExp(`${mark} (\\d+) (\\d+)`).exec(term.text())!;
    const host = document.querySelector(".term-body") as HTMLElement;
    await log(`${label}: xterm ${term.size().cols}x${term.size().rows} · pty ${m[2]}x${m[1]} · pane ${host.clientWidth}x${host.clientHeight}px · dpr ${devicePixelRatio}`);
  };
  await probe("start");
  // Change the pane's width the way the user does: by closing side panels.
  ui.toggleTree(false);
  ui.toggleRight(false);
  await sleep(1200);
  await probe("panels closed");
  ui.toggleTree(true);
  ui.toggleRight(true);
  await sleep(1200);
  await probe("panels open");
  const cell = document.querySelector(".xterm-screen") as HTMLElement | null;
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `13px ${getComputedStyle(document.documentElement).getPropertyValue("--font-mono")}`;
  await log(
    `cell ${((cell?.clientWidth ?? 0) / term.size().cols).toFixed(2)} px/col; glyph at 13px ${ctx.measureText("W").width.toFixed(2)} px`,
  );
  await core.sessionRemove(s.id, false, false);
}

export async function runSmoke(mode: string) {
  if (mode === "size") {
    try {
      await until("workspace", () => !!workspace());
      await until("sessiond", () => sessions.connected() === true);
      await sizeSmoke();
    } catch (e) {
      await log(`FAIL ${e instanceof Error ? e.message : String(e)}`);
    }
    return core.quit();
  }
  if (mode === "claude") {
    try {
      await until("workspace", () => !!workspace());
      await until("sessiond", () => sessions.connected() === true);
      await claudeSmoke();
    } catch (e) {
      await log(`FAIL ${e instanceof Error ? e.message : String(e)}`);
    }
    return core.quit();
  }
  try {
    await until("workspace", () => !!workspace());
    await until("sessiond", () => sessions.connected() === true);
    const old = sessions.here().find((s) => s.name === "smoke" && s.alive);
    if (!old) {
      const t0 = performance.now();
      const err = await sessions.create({ agent: "shell", name: "smoke" });
      if (err) throw new Error(err);
      const s = sessions.here().find((x) => x.name === "smoke")!;
      await log(`created ${s.id} in ${Math.round(performance.now() - t0)} ms (${s.cwd}, ${s.branch})`);
      const term = await sessions.terminal(s.id);
      await until("terminal opened", () => term.opened);
      await sleep(800);
      await core.sessionInput(s.id, "echo smoke-$((40+2))\r");
      await until("echo output", () => term.text().includes("smoke-42"));
      await log(`typed and read back: ok (${term.size().cols}x${term.size().rows})`);
      await log("PASS run 1: quitting with the session alive");
    } else {
      await log(`found ${old.id} alive after restart`);
      await sessions.focusSession(old.id);
      const term = await sessions.terminal(old.id);
      await until("history replay", () => term.text().includes("smoke-42"));
      await log("history replayed: ok");
      await core.sessionInput(old.id, "echo again-$((1+1))\r");
      await until("still interactive", () => term.text().includes("again-2"));
      await log("still interactive: ok");
      await core.sessionRemove(old.id, false, false);
      await until("removed", () => !sessions.here().some((x) => x.id === old.id));
      await log("PASS run 2: removed");
    }
  } catch (e) {
    await log(`FAIL ${e instanceof Error ? e.message : String(e)}`);
  }
  await core.quit();
}
