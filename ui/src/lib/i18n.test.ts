import { afterEach, describe, expect, it } from "vitest";
import { errorText, KEYS, locale, parseLocale, setLocale, t } from "./i18n";
import { statusView } from "./sessions";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("i18n", () => {
  afterEach(() => setLocale("en"));

  it("defaults to English and switches live", () => {
    expect(locale()).toBe("en");
    expect(t("status.waiting")).toBe("waiting for you");
    setLocale("pt-BR");
    expect(t("status.waiting")).toBe("aguardando você");
    expect(statusView({ status: "waiting", alive: true, exitCode: null }).label).toBe("aguardando você");
  });

  it("fills placeholders", () => {
    expect(t("sess.startedOn", { name: "claude-1", branch: "main" })).toBe("claude-1 started on main");
    setLocale("pt-BR");
    expect(t("sess.startedOn", { name: "claude-1", branch: "main" })).toBe("claude-1 iniciada em main");
  });

  it("keeps the same placeholders in every language", () => {
    const enText = new Map(KEYS.map((k) => [k, t(k)]));
    setLocale("pt-BR");
    for (const k of KEYS) expect(placeholders(t(k)), k).toEqual(placeholders(enText.get(k)!));
  });

  it("translates core errors by kind, falling back to the message", () => {
    setLocale("pt-BR");
    expect(errorText("not_repo", "/x")).toBe("não é um repositório git: /x");
    expect(errorText("io", "boom")).toBeNull();
  });

  it("parses language names", () => {
    expect(parseLocale("pt")).toBe("pt-BR");
    expect(parseLocale("PT-BR")).toBe("pt-BR");
    expect(parseLocale("en")).toBe("en");
    expect(parseLocale("fr")).toBeNull();
  });
});
