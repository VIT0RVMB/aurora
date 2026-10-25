//! Color themes from Base16 / Base24 schemes (tinted-theming), dropped as
//! `.yaml` files into `<data dir>/themes`. A scheme has 16 (or 24) colors with
//! fixed roles; [`tokens`] maps them onto the UI's design tokens, deriving the
//! in-between shades, so every scheme fills the whole app the same way.

use std::{collections::BTreeMap, path::Path};

use serde::Serialize;

use crate::{Error, Result};

/// Themes folder inside the data dir.
pub fn dir(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("themes")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    fn parse(s: &str) -> Option<Rgb> {
        let h = s.trim().trim_start_matches('#');
        if h.len() != 6 || !h.is_ascii() {
            return None;
        }
        let c = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
        Some(Rgb(c(0)?, c(2)?, c(4)?))
    }

    fn hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.0, self.1, self.2)
    }

    fn rgba(self, alpha: f32) -> String {
        format!("rgba({}, {}, {}, {alpha})", self.0, self.1, self.2)
    }

    /// `self` moved toward `other` by `t` (0 = self, 1 = other).
    fn mix(self, other: Rgb, t: f32) -> Rgb {
        let m = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t).round() as u8;
        Rgb(m(self.0, other.0), m(self.1, other.1), m(self.2, other.2))
    }

    /// Relative luminance (WCAG), 0..1.
    fn luminance(self) -> f32 {
        let lin = |c: u8| {
            let c = c as f32 / 255.0;
            if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
        };
        0.2126 * lin(self.0) + 0.7152 * lin(self.1) + 0.0722 * lin(self.2)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Variant {
    Dark,
    Light,
}

#[derive(Debug, Clone)]
pub struct Scheme {
    pub name: String,
    pub author: String,
    pub variant: Variant,
    /// base00..base17. A Base16 scheme gets base10..base17 filled in.
    pub base: [Rgb; 24],
    /// Which base color is the UI accent: base0D unless the scheme says
    /// `accent: "base09"` (an Aurora extension other tools ignore).
    pub accent: usize,
}

/// Schemes shipped inside the app; a file with the same id in the themes
/// folder takes their place.
const BUILTIN: &[(&str, &str)] = &[("ember", include_str!("../themes/ember.yaml"))];

/// Parses a scheme in either tinted-theming layout: the legacy flat one
/// (`scheme:`, `base00: "282828"`) or the current one (`name:`, `variant:`,
/// `palette:` with `base00: "#282828"`). Only the keys used here are read, so
/// this line reader stands in for a YAML dependency.
pub fn parse(text: &str) -> Result<Scheme> {
    let mut name = None;
    let mut author = String::new();
    let mut variant = None;
    let mut base: [Option<Rgb>; 24] = [None; 24];
    let mut accent = 0xD;
    for line in text.lines() {
        let line = line.split(" #").next().unwrap_or("").trim();
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        match key.trim() {
            "name" | "scheme" => name = Some(value.to_string()),
            "author" => author = value.to_string(),
            "variant" => {
                variant = match value {
                    "dark" => Some(Variant::Dark),
                    "light" => Some(Variant::Light),
                    _ => None,
                }
            }
            "accent" => {
                accent = value
                    .strip_prefix("base")
                    .and_then(|n| usize::from_str_radix(n, 16).ok())
                    .filter(|&i| i < 24)
                    .ok_or_else(|| bad(&format!("invalid accent: {value}")))?;
            }
            k if k.len() == 6 && k.starts_with("base") => {
                let Ok(i) = usize::from_str_radix(&k[4..], 16) else { continue };
                if i < 24 {
                    base[i] = Some(
                        Rgb::parse(value).ok_or_else(|| bad(&format!("invalid color in {k}: {value}")))?,
                    );
                }
            }
            _ => {}
        }
    }
    let name = name.filter(|n| !n.is_empty()).ok_or_else(|| bad("missing name (scheme/name)"))?;
    let mut full = [Rgb(0, 0, 0); 24];
    for i in 0..16 {
        full[i] = base[i].ok_or_else(|| bad(&format!("missing base{i:02X}")))?;
    }
    let variant = variant.unwrap_or(if full[0].luminance() < full[5].luminance() {
        Variant::Dark
    } else {
        Variant::Light
    });
    // Base24 extras; a Base16 scheme falls back as the Base24 spec says:
    // deeper backgrounds from base00, bright colors equal to the normal ones.
    let fallback = [
        full[0].mix(Rgb(0, 0, 0), 0.15),
        full[0].mix(Rgb(0, 0, 0), 0.3),
        full[0x8],
        full[0xA],
        full[0xB],
        full[0xC],
        full[0xD],
        full[0xE],
    ];
    for i in 16..24 {
        full[i] = base[i].unwrap_or(fallback[i - 16]);
    }
    Ok(Scheme { name, author, variant, base: full, accent })
}

fn bad(msg: &str) -> Error {
    Error::BadTheme(msg.to_string())
}

/// Design-token values (`--bg` → `#282828`) for a scheme.
pub fn tokens(s: &Scheme) -> BTreeMap<&'static str, String> {
    let b = |i: usize| s.base[i];
    let mut t = BTreeMap::new();
    let mut set = |k: &'static str, v: String| {
        t.insert(k, v);
    };
    let h = |i: usize| b(i).hex();

    set("color-scheme", if s.variant == Variant::Dark { "dark" } else { "light" }.into());
    set("--bg", h(0x0));
    set("--bg-panel", b(0x0).mix(b(0x1), 0.4).hex());
    set("--bg-raised", h(0x1));
    set("--bg-hover", b(0x1).mix(b(0x2), 0.4).hex());
    set("--bg-select", h(0x2));
    set("--bg-select-dim", b(0x1).mix(b(0x2), 0.6).hex());
    set("--line", b(0x1).mix(b(0x2), 0.5).hex());
    set("--line-strong", b(0x2).mix(b(0x3), 0.75).hex());
    set("--fg", h(0x5));
    set("--fg-dim", h(0x4));
    set("--fg-faint", h(0x3));
    set("--accent", h(s.accent));
    set("--accent-fg", h(0x0));
    set("--accent-2", h(0xE));
    set("--warn", h(0xA));
    set("--danger", h(0x8));
    set("--info", h(0xC));
    set("--match", h(s.accent));
    set("--match-bg", b(s.accent).rgba(0.18));
    set("--cursor", h(0x5));
    set("--selection", b(0x2).rgba(0.8));

    set("--syn-keyword", h(0xE));
    set("--syn-string", h(0xB));
    set("--syn-number", h(0x9));
    set("--syn-comment", h(0x3));
    set("--syn-function", h(0xD));
    set("--syn-type", h(0xA));
    set("--syn-variable", h(0x5));
    set("--syn-property", h(0x8));
    set("--syn-operator", h(0x4));
    set("--syn-tag", h(0x8));
    set("--syn-attr", h(0x9));
    set("--syn-heading", h(s.accent));
    set("--syn-link", h(0xC));

    // Black and bright black are lifted off the background so they stay
    // visible; the rest follows the Base24 terminal mapping.
    for (k, i) in [
        ("--ansi-black", 0x1),
        ("--ansi-red", 0x8),
        ("--ansi-green", 0xB),
        ("--ansi-yellow", 0xA),
        ("--ansi-blue", 0xD),
        ("--ansi-magenta", 0xE),
        ("--ansi-cyan", 0xC),
        ("--ansi-white", 0x5),
        ("--ansi-bright-black", 0x3),
        ("--ansi-bright-red", 0x12),
        ("--ansi-bright-green", 0x14),
        ("--ansi-bright-yellow", 0x13),
        ("--ansi-bright-blue", 0x16),
        ("--ansi-bright-magenta", 0x17),
        ("--ansi-bright-cyan", 0x15),
        ("--ansi-bright-white", 0x7),
    ] {
        t.insert(k, h(i));
    }
    t
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeInfo {
    /// File stem; what `:theme <id>` takes.
    pub id: String,
    pub name: String,
    pub variant: Variant,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeTokens {
    pub id: String,
    pub name: String,
    pub variant: Variant,
    pub tokens: BTreeMap<&'static str, String>,
}

fn scheme_files(dir: &Path) -> Vec<(String, std::path::PathBuf)> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<_> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| matches!(p.extension().and_then(|e| e.to_str()), Some("yaml" | "yml")))
        .filter_map(|p| Some((p.file_stem()?.to_str()?.to_string(), p)))
        .collect();
    out.sort();
    out
}

/// Built-in schemes, then the ones in `dir` sorted by id. Files that don't
/// parse are skipped; a missing folder just leaves the built-ins.
pub fn list(dir: &Path) -> Vec<ThemeInfo> {
    let files = scheme_files(dir);
    let builtin: Vec<_> = BUILTIN
        .iter()
        .filter(|(id, _)| !files.iter().any(|(stem, _)| stem == id))
        .filter_map(|(id, text)| Some((id.to_string(), parse(text).ok()?)))
        .collect();
    let found =
        files.into_iter().filter_map(|(id, p)| Some((id, parse(&std::fs::read_to_string(p).ok()?).ok()?)));
    builtin
        .into_iter()
        .chain(found)
        .map(|(id, s)| ThemeInfo { id, name: s.name, variant: s.variant })
        .collect()
}

/// Loads scheme `id` (file stem) from `dir` and maps it to tokens.
pub fn load(dir: &Path, id: &str) -> Result<ThemeTokens> {
    if id.is_empty() || id.contains(['/', '\\']) || id.starts_with('.') {
        return Err(Error::BadName(id.to_string()));
    }
    let s = match scheme_files(dir).into_iter().find(|(stem, _)| stem == id) {
        Some((_, path)) => parse(&std::fs::read_to_string(path)?)?,
        None => {
            let (_, text) = BUILTIN
                .iter()
                .find(|(b, _)| *b == id)
                .ok_or_else(|| bad(&format!("theme not found: {id}")))?;
            parse(text)?
        }
    };
    Ok(ThemeTokens { id: id.to_string(), name: s.name.clone(), variant: s.variant, tokens: tokens(&s) })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEGACY: &str = r#"
scheme: "Gruvbox dark, medium"
author: "Dawid Kurek (dawikur@gmail.com), morhetz (https://github.com/morhetz/gruvbox)"
base00: "282828" # ----
base01: "3c3836"
base02: "504945"
base03: "665c54"
base04: "bdae93"
base05: "d5c4a1"
base06: "ebdbb2"
base07: "fbf1c7"
base08: "fb4934"
base09: "fe8019"
base0A: "fabd2f"
base0B: "b8bb26"
base0C: "8ec07c"
base0D: "83a598"
base0E: "d3869b"
base0F: "d65d0e"
"#;

    #[test]
    fn parses_legacy_base16_and_fills_base24() {
        let s = parse(LEGACY).unwrap();
        assert_eq!(s.name, "Gruvbox dark, medium");
        assert_eq!(s.variant, Variant::Dark);
        assert_eq!(s.base[0], Rgb(0x28, 0x28, 0x28));
        assert_eq!(s.base[0xD], Rgb(0x83, 0xa5, 0x98));
        // Bright colors fall back to the normal ones.
        assert_eq!(s.base[0x12], s.base[0x8]);
        assert_eq!(s.base[0x16], s.base[0xD]);
    }

    #[test]
    fn parses_current_layout_with_palette() {
        let text = r##"
system: "base24"
name: "Light One"
author: "x"
variant: "light"
palette:
  base00: "#fafafa"
  base01: "#f0f0f0"
  base02: "#e5e5e5"
  base03: "#a0a1a7"
  base04: "#696c77"
  base05: "#383a42"
  base06: "#202227"
  base07: "#090a0b"
  base08: "#e45649"
  base09: "#986801"
  base0A: "#c18401"
  base0B: "#50a14f"
  base0C: "#0184bc"
  base0D: "#4078f2"
  base0E: "#a626a4"
  base0F: "#ca1243"
  base10: "#f5f5f5"
  base11: "#eeeeee"
  base12: "#ff6b5e"
  base13: "#e0a400"
  base14: "#6fc26e"
  base15: "#1ea8e0"
  base16: "#6696ff"
  base17: "#c44ac2"
"##;
        let s = parse(text).unwrap();
        assert_eq!(s.name, "Light One");
        assert_eq!(s.variant, Variant::Light);
        assert_eq!(s.base[0x12], Rgb(0xff, 0x6b, 0x5e));
        assert_eq!(tokens(&s)["--ansi-bright-red"], "#ff6b5e");
        assert_eq!(tokens(&s)["color-scheme"], "light");
    }

    #[test]
    fn variant_guessed_from_luminance() {
        let light = LEGACY.replace("\"282828\"", "\"fbf1c7\"").replace("\"d5c4a1\"", "\"3c3836\"");
        assert_eq!(parse(&light).unwrap().variant, Variant::Light);
    }

    #[test]
    fn rejects_incomplete_or_bad_colors() {
        assert!(parse(&LEGACY.replace("base0F: \"d65d0e\"", "")).is_err());
        assert!(parse(&LEGACY.replace("\"d65d0e\"", "\"zz5d0e\"")).is_err());
        assert!(parse("base00: \"000000\"").is_err());
    }

    #[test]
    fn tokens_cover_every_css_token() {
        let t = tokens(&parse(LEGACY).unwrap());
        // Every token defined for the built-in themes gets a value.
        let css = include_str!("../../../ui/src/styles/tokens.css");
        let block = css.split(":root[data-theme=\"light\"]").nth(1).unwrap();
        for line in block.lines() {
            if let Some(name) = line.trim().strip_prefix("--").and_then(|l| l.split(':').next()) {
                let key = format!("--{name}");
                assert!(t.contains_key(key.as_str()), "missing {key}");
            }
        }
        assert_eq!(t["--bg"], "#282828");
        assert_eq!(t["--bg-panel"], "#302e2e");
        assert_eq!(t["--match-bg"], "rgba(131, 165, 152, 0.18)");
    }

    #[test]
    fn list_and_load_from_folder() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("gruvbox-dark-medium.yaml"), LEGACY).unwrap();
        std::fs::write(d.path().join("broken.yaml"), "scheme: x").unwrap();
        std::fs::write(d.path().join("notes.txt"), LEGACY).unwrap();
        let l = list(d.path());
        let ids: Vec<_> = l.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["ember", "gruvbox-dark-medium"]);
        let t = load(d.path(), "gruvbox-dark-medium").unwrap();
        assert_eq!(t.tokens["--accent"], "#83a598");
        assert!(load(d.path(), "../x").is_err());
        assert!(load(d.path(), "missing").is_err());
        assert_eq!(list(&d.path().join("nope")).len(), BUILTIN.len());
    }

    #[test]
    fn builtin_ember_uses_its_accent_and_yields_to_a_file() {
        let d = tempfile::tempdir().unwrap();
        let t = load(d.path(), "ember").unwrap();
        assert_eq!(t.name, "Ember");
        assert_eq!(t.tokens["--accent"], "#e08850");
        assert_eq!(t.tokens["--ansi-blue"], "#7f9fc4");
        std::fs::write(d.path().join("ember.yaml"), LEGACY).unwrap();
        assert_eq!(load(d.path(), "ember").unwrap().tokens["--accent"], "#83a598");
        assert_eq!(list(d.path()).len(), 1);
    }

    #[test]
    fn rejects_a_bad_accent() {
        assert!(parse(&format!("{LEGACY}accent: \"base99\"\n")).is_err());
        assert_eq!(parse(&format!("{LEGACY}accent: \"base09\"\n")).unwrap().accent, 9);
    }
}
