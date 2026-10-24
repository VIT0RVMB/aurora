import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  FONT_CHOICES,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  fontFamily,
  fontInstalled,
  fontLabel,
  fontSize,
  setFontFamily,
  setFontSize,
} from "../state/prefs";
import { refreshThemes, setTheme, theme, themes, themesDir } from "../state/theme";
import { notify, setPrefsOpen } from "../state/ui";
import { LOCALES, locale, setLocale, t, type Locale } from "../lib/i18n";

interface Row {
  id: string;
  label: string;
  tag: string;
  dim?: boolean;
}

/** Arrow-key list; moving the highlight applies the choice right away. */
function Choices(p: {
  rows: Row[];
  current: string;
  onPick: (id: string) => void;
  family?: (id: string) => string;
  /** Fits its rows instead of the fixed list height. */
  short?: boolean;
}) {
  let el!: HTMLDivElement;
  const index = () => Math.max(0, p.rows.findIndex((r) => r.id === p.current));
  const move = (d: number) => {
    const n = p.rows.length;
    if (!n) return;
    p.onPick(p.rows[(index() + d + n) % n].id);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "j") move(1);
    else if (e.key === "ArrowUp" || e.key === "k") move(-1);
    else return;
    e.preventDefault();
    queueMicrotask(() => el.querySelector(".selected")?.scrollIntoView({ block: "nearest" }));
  };
  return (
    <div ref={el} class="prefs-list" classList={{ short: p.short }} tabindex={0} onKeyDown={onKey}>
      <For each={p.rows}>
        {(r) => (
          <div
            class="palette-item"
            classList={{ selected: r.id === p.current, faint: r.dim }}
            onClick={() => {
              p.onPick(r.id);
              el.focus();
            }}
          >
            <span style={p.family ? { "font-family": p.family(r.id) } : undefined}>{r.label}</span>
            <span class="dim">{r.tag}</span>
          </div>
        )}
      </For>
    </div>
  );
}

/** Preferences: theme, language, font family and size. Everything applies as you move. */
export function Prefs() {
  const close = () => setPrefsOpen(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  onMount(() => {
    window.addEventListener("keydown", onKey, true);
    void refreshThemes();
  });
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  const themeRows = createMemo<Row[]>(() => [
    { id: "dark", label: "Phosphor", tag: t("theme.dark") },
    { id: "light", label: "Aurora Light", tag: t("theme.light") },
    ...themes().map((th) => ({ id: th.id, label: th.name, tag: t(th.variant === "dark" ? "theme.dark" : "theme.light") })),
  ]);
  const pickTheme = async (id: string) => {
    const err = await setTheme(id);
    if (err) notify(err, "error");
  };

  const DEFAULT = "";
  const fontRows = createMemo<Row[]>(() => {
    const custom = fontFamily();
    const list = custom && !FONT_CHOICES.includes(custom) ? [...FONT_CHOICES, custom] : FONT_CHOICES;
    return [
      { id: DEFAULT, label: t("prefs.default"), tag: "" },
      ...list.map((f) => {
        const ok = fontInstalled(f);
        return { id: f, label: fontLabel(f), tag: ok ? "" : t("prefs.notInstalled"), dim: !ok };
      }),
    ];
  });
  const [custom, setCustom] = createSignal("");
  const addCustom = (e: Event) => {
    e.preventDefault();
    const f = custom().trim();
    if (!f) return;
    if (!fontInstalled(f)) notify(t("prefs.fontNotFound", { name: f }), "warn");
    setFontFamily(f);
    setCustom("");
  };

  return (
    <div class="palette-backdrop" onMouseDown={close}>
      <div class="palette prefs" role="dialog" aria-label={t("prefs.title")} onMouseDown={(e) => e.stopPropagation()}>
        <div class="palette-input">
          <b>{t("prefs.title")}</b>
          <span class="faint prefs-hint">{t("prefs.hint")}</span>
        </div>
        <div class="prefs-body">
          <section class="prefs-col">
            <div class="prefs-head">{t("prefs.theme")}</div>
            <Choices rows={themeRows()} current={theme()} onPick={(id) => void pickTheme(id)} />
            <Show when={themesDir()}>
              <div class="prefs-note faint" title={themesDir()}>
                {t("prefs.schemes", { dir: themesDir().replace(/^\/Users\/[^/]+/, "~") })}
              </div>
            </Show>
            <div class="prefs-head">{t("prefs.language")}</div>
            <Choices
              short
              rows={LOCALES.map((l) => ({ id: l.id, label: l.label, tag: l.id }))}
              current={locale()}
              onPick={(id) => setLocale(id as Locale)}
            />
          </section>
          <section class="prefs-col">
            <div class="prefs-head">{t("prefs.font")}</div>
            <Choices
              rows={fontRows()}
              current={fontFamily() ?? DEFAULT}
              onPick={(id) => setFontFamily(id || null)}
              family={(id) => (id ? (id === "ui-monospace" ? "ui-monospace" : `"${id}", monospace`) : "var(--font-mono)")}
            />
            <form class="prefs-custom" onSubmit={addCustom}>
              <span class="faint">{t("prefs.other")}</span>
              <input
                value={custom()}
                onInput={(e) => setCustom(e.currentTarget.value)}
                placeholder={t("prefs.family")}
                spellcheck={false}
                autocomplete="off"
              />
            </form>
            <div class="prefs-head">{t("prefs.size")}</div>
            <div class="prefs-size">
              <button disabled={fontSize() <= FONT_SIZE_MIN} onClick={() => setFontSize(fontSize() - 1)}>
                [−]
              </button>
              <input
                type="number"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                value={fontSize()}
                onChange={(e) => setFontSize(Number(e.currentTarget.value) || fontSize())}
              />
              <span class="faint">px</span>
              <button disabled={fontSize() >= FONT_SIZE_MAX} onClick={() => setFontSize(fontSize() + 1)}>
                [+]
              </button>
            </div>
            <div class="prefs-preview">
              <span class="kw">fn</span> <span class="fn">main</span>() {"{ "}
              <span class="str">"0O il1 {"=>"} ~"</span>
              {" }"}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
