//! Which extractor reads a document.
//!
//! **An unresolved format is not an error.** It falls through to a scan
//! of the raw text, because that is the case that matters most: a
//! Kubernetes manifest, a Markdown table of limits, a `.tf` file and a
//! log line all hold quantities, and a tool that had to be told what
//! each file was would never be pointed at a repository.
//!
//! There are no source-language readers here, unlike numbers-le. A
//! quantity in source code is written as a string — `Duration::from(…)`
//! takes a number, `"30s"` is what appears in a literal — so the text
//! scan finds it, and a numeric-literal lexer would find nothing extra.

use serde::{Deserialize, Serialize};

/// Which reader a document goes to.
///
/// **An enum rather than a string**, so the two places that dispatch on
/// it — `harvest` and `parse_error` — match every variant and adding a
/// reader is a compile error in both until it is wired up. A string
/// dispatch needed a catch-all arm, and a catch-all arm turns a
/// half-added format into a document that reports its own name and is
/// quietly scanned as text instead.
///
/// The spelling is user-visible: it is the `format` in every report line
/// and the `fileType` every MCP answer carries, so `name()` and the
/// serde representation are held equal by a test.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Format {
    Json,
    /// JSON with comments and trailing commas — the same reader, with the
    /// two loosenings that define the format turned on. Routing `.jsonc`
    /// at the strict reader made the one thing the extension exists for
    /// the one thing it could not read.
    Jsonc,
    Yaml,
    Csv,
    /// Tab-separated, which is the same reader with a different
    /// delimiter. Routing `.tsv` at the comma reader made a whole row one
    /// cell, so no cell was a quantity and the file reported clean.
    Tsv,
    Toml,
    Ini,
    Env,
    /// Everything else, read by the text scan. `unknown` rather than
    /// `fallback`, because the name is what a reader sees.
    Unknown,
}

impl Format {
    /// Every variant, so a test can walk them. Compiled for the tests
    /// alone rather than shipped behind a `dead_code` relaxation — this
    /// crate carries no inline lint attribute.
    #[cfg(test)]
    pub(crate) const ALL: [Self; 9] = [
        Self::Json,
        Self::Jsonc,
        Self::Yaml,
        Self::Csv,
        Self::Tsv,
        Self::Toml,
        Self::Ini,
        Self::Env,
        Self::Unknown,
    ];

    /// The name a report carries and a caller may ask for.
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Jsonc => "jsonc",
            Self::Yaml => "yaml",
            Self::Csv => "csv",
            Self::Tsv => "tsv",
            Self::Toml => "toml",
            Self::Ini => "ini",
            Self::Env => "env",
            Self::Unknown => "unknown",
        }
    }
}

/// Every name a caller might send, mapped to the reader it means. Both a
/// VS Code `languageId` and a file extension appear here, because a
/// caller may resolve by either.
/// `conf` and `cfg` are deliberately absent. They named the INI reader,
/// which accepts free-form text as a valid document holding no values —
/// so an nginx or redis config, which is where quantities actually live,
/// came back with no findings and no diagnostic, reading as a file that
/// was clean. They fall to the text scan, which reads them.
/// `properties` stays: `app.timeout=30s` really is INI.
const ALIASES: [(&str, Format); 13] = [
    ("json", Format::Json),
    ("jsonc", Format::Jsonc),
    ("yaml", Format::Yaml),
    ("yml", Format::Yaml),
    ("csv", Format::Csv),
    ("tsv", Format::Tsv),
    ("toml", Format::Toml),
    ("ini", Format::Ini),
    ("properties", Format::Ini),
    ("env", Format::Env),
    ("dotenv", Format::Env),
    ("editorconfig", Format::Ini),
    ("prometheus", Format::Yaml),
];

/// The formats a caller can name, for the tool schema's enum. Taken from
/// the variants themselves and held equal to the alias table by a test,
/// so a format can never be offered and then not resolve. `Unknown` is
/// not offered: it is where an unrecognised name lands, not a name to
/// ask for.
pub(crate) const SUPPORTED_FORMATS: [&str; 8] = [
    Format::Json.name(),
    Format::Jsonc.name(),
    Format::Yaml.name(),
    Format::Csv.name(),
    Format::Tsv.name(),
    Format::Toml.name(),
    Format::Ini.name(),
    Format::Env.name(),
];

fn normalise(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .trim_start_matches('.')
        .to_string()
}

/// The reader for one already-normalised name, or the fallback.
fn canonical(format: &str) -> Format {
    ALIASES
        .iter()
        .find(|(alias, _)| *alias == format)
        .map_or(Format::Unknown, |(_, reader)| *reader)
}

/// Resolve a reader from an explicit format, else from a filename, else
/// the fallback.
pub(crate) fn resolve_format(format: Option<&str>, filename: Option<&str>) -> Format {
    if let Some(name) = format {
        let direct = canonical(&normalise(name));
        if direct != Format::Unknown {
            return direct;
        }
    }

    let Some(filename) = filename else {
        return Format::Unknown;
    };

    // A dotfile like `.env` has no extension to split on; its whole name
    // is the type.
    let whole = canonical(&normalise(filename));
    if whole != Format::Unknown {
        return whole;
    }

    filename
        .rsplit_once('.')
        .map_or(Format::Unknown, |(_, extension)| {
            canonical(&normalise(extension))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_offered_format_resolves_to_itself() {
        for format in SUPPORTED_FORMATS {
            assert_eq!(
                resolve_format(Some(format), None).name(),
                format,
                "{format}"
            );
        }
    }

    #[test]
    fn the_aliases_are_honoured() {
        for (alias, expected) in [
            ("jsonc", Format::Jsonc),
            ("yml", Format::Yaml),
            ("tsv", Format::Tsv),
            ("dotenv", Format::Env),
        ] {
            assert_eq!(resolve_format(Some(alias), None), expected, "{alias}");
        }
    }

    #[test]
    fn a_name_is_normalised_before_it_is_matched() {
        assert_eq!(resolve_format(Some("  JSON "), None), Format::Json);
        assert_eq!(resolve_format(Some(".toml"), None), Format::Toml);
    }

    #[test]
    fn a_filename_supplies_the_format_when_none_is_named() {
        assert_eq!(resolve_format(None, Some("config.toml")), Format::Toml);
        assert_eq!(resolve_format(None, Some("data.CSV")), Format::Csv);
    }

    #[test]
    fn a_dotfile_resolves_by_its_whole_name() {
        assert_eq!(resolve_format(None, Some(".env")), Format::Env);
        assert_eq!(resolve_format(None, Some("env")), Format::Env);
    }

    /// The property the audit story rests on. Not a refusal, not an
    /// empty result — the text scan, which is what reads a Kubernetes
    /// manifest nobody named or a Markdown table of limits.
    #[test]
    fn anything_unrecognised_falls_back() {
        for name in ["markdown", "dockerfile", "", "wat"] {
            assert_eq!(resolve_format(Some(name), None), Format::Unknown, "{name}");
        }
        assert_eq!(resolve_format(None, Some("README.md")), Format::Unknown);
        assert_eq!(resolve_format(None, Some("Makefile")), Format::Unknown);
        assert_eq!(resolve_format(None, None), Format::Unknown);
    }

    /// An explicit format that resolves to nothing still lets the
    /// filename answer, rather than the bad name poisoning the lookup.
    #[test]
    fn an_unresolved_format_defers_to_the_filename() {
        assert_eq!(
            resolve_format(Some("nonsense"), Some("a.toml")),
            Format::Toml
        );
    }

    #[test]
    fn the_offered_list_matches_the_alias_table() {
        for format in SUPPORTED_FORMATS {
            assert!(
                ALIASES.iter().any(|(_, reader)| reader.name() == format),
                "{format} is offered but no alias produces it"
            );
        }
        for (_, reader) in ALIASES {
            assert!(
                SUPPORTED_FORMATS.contains(&reader.name()),
                "{} is produced but not offered",
                reader.name()
            );
        }
    }

    /// The fallback is the one variant no alias may produce: it is where
    /// an unrecognised name lands, and an alias for it would let a caller
    /// ask for "no reader" by name.
    #[test]
    fn nothing_resolves_to_the_fallback_on_purpose() {
        assert!(ALIASES.iter().all(|(_, reader)| *reader != Format::Unknown));
        assert!(!SUPPORTED_FORMATS.contains(&Format::Unknown.name()));
    }

    /// `name()` is what a report prints and what a caller types; the
    /// serde spelling is what the JSON carries. Nothing makes them
    /// agree, and a reader filtering on one against the other would find
    /// nothing and see no error.
    #[test]
    fn a_name_and_its_serialised_spelling_are_the_same_word() {
        for format in Format::ALL {
            let serialised = serde_json::to_value(format).expect("a format serializes");
            assert_eq!(
                serialised.as_str(),
                Some(format.name()),
                "{format:?} is one word to name() and another to serde"
            );
        }
    }
}
