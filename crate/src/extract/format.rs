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

/// Every name a caller might send, mapped to the extractor key it
/// means. Both a VS Code `languageId` and a file extension appear here,
/// because a caller may resolve by either.
const ALIASES: [(&str, &str); 15] = [
    ("json", "json"),
    ("jsonc", "json"),
    ("yaml", "yaml"),
    ("yml", "yaml"),
    ("csv", "csv"),
    ("tsv", "csv"),
    ("toml", "toml"),
    ("ini", "ini"),
    ("cfg", "ini"),
    ("conf", "ini"),
    ("properties", "ini"),
    ("env", "env"),
    ("dotenv", "env"),
    ("editorconfig", "ini"),
    ("prometheus", "yaml"),
];

/// The formats a caller can name, for the tool schema's enum. Held
/// equal to the alias table by a test, so a format can never be offered
/// and then not resolve.
pub(crate) const SUPPORTED_FORMATS: [&str; 6] = ["json", "yaml", "csv", "toml", "ini", "env"];

/// What the engine uses when it recognises nothing.
///
/// `unknown` rather than `fallback`, because the name is user-visible:
/// it is the `fileType` every MCP answer carries and the `format` in
/// every report line.
pub(crate) const FALLBACK_FORMAT: &str = "unknown";

fn normalise(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .trim_start_matches('.')
        .to_string()
}

/// The extractor key for an already-canonical format name, or the
/// fallback. Used on the hot path, where the caller has resolved once.
pub(crate) fn canonical(format: &str) -> &'static str {
    ALIASES
        .iter()
        .find(|(alias, _)| *alias == format)
        .map_or(FALLBACK_FORMAT, |(_, key)| *key)
}

/// Resolve an extractor key from an explicit format, else from a
/// filename, else the fallback.
pub(crate) fn resolve_format(format: Option<&str>, filename: Option<&str>) -> &'static str {
    if let Some(name) = format {
        let direct = canonical(&normalise(name));
        if direct != FALLBACK_FORMAT {
            return direct;
        }
    }

    let Some(filename) = filename else {
        return FALLBACK_FORMAT;
    };

    // A dotfile like `.env` has no extension to split on; its whole name
    // is the type.
    let whole = canonical(&normalise(filename));
    if whole != FALLBACK_FORMAT {
        return whole;
    }

    filename
        .rsplit_once('.')
        .map_or(FALLBACK_FORMAT, |(_, extension)| {
            canonical(&normalise(extension))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_offered_format_resolves_to_itself() {
        for format in SUPPORTED_FORMATS {
            assert_eq!(resolve_format(Some(format), None), format, "{format}");
        }
    }

    #[test]
    fn the_aliases_are_honoured() {
        for (alias, expected) in [
            ("jsonc", "json"),
            ("yml", "yaml"),
            ("tsv", "csv"),
            ("cfg", "ini"),
            ("conf", "ini"),
            ("dotenv", "env"),
        ] {
            assert_eq!(resolve_format(Some(alias), None), expected, "{alias}");
        }
    }

    #[test]
    fn a_name_is_normalised_before_it_is_matched() {
        assert_eq!(resolve_format(Some("  JSON "), None), "json");
        assert_eq!(resolve_format(Some(".toml"), None), "toml");
    }

    #[test]
    fn a_filename_supplies_the_format_when_none_is_named() {
        assert_eq!(resolve_format(None, Some("config.toml")), "toml");
        assert_eq!(resolve_format(None, Some("data.CSV")), "csv");
    }

    #[test]
    fn a_dotfile_resolves_by_its_whole_name() {
        assert_eq!(resolve_format(None, Some(".env")), "env");
        assert_eq!(resolve_format(None, Some("env")), "env");
    }

    /// The property the audit story rests on. Not a refusal, not an
    /// empty result — the text scan, which is what reads a Kubernetes
    /// manifest nobody named or a Markdown table of limits.
    #[test]
    fn anything_unrecognised_falls_back() {
        for name in ["markdown", "dockerfile", "", "wat"] {
            assert_eq!(resolve_format(Some(name), None), FALLBACK_FORMAT, "{name}");
        }
        assert_eq!(resolve_format(None, Some("README.md")), FALLBACK_FORMAT);
        assert_eq!(resolve_format(None, Some("Makefile")), FALLBACK_FORMAT);
        assert_eq!(resolve_format(None, None), FALLBACK_FORMAT);
    }

    /// An explicit format that resolves to nothing still lets the
    /// filename answer, rather than the bad name poisoning the lookup.
    #[test]
    fn an_unresolved_format_defers_to_the_filename() {
        assert_eq!(resolve_format(Some("nonsense"), Some("a.toml")), "toml");
    }

    #[test]
    fn the_offered_list_matches_the_alias_table() {
        for format in SUPPORTED_FORMATS {
            assert!(
                ALIASES.iter().any(|(_, key)| *key == format),
                "{format} is offered but no alias produces it"
            );
        }
        for (_, key) in ALIASES {
            assert!(
                SUPPORTED_FORMATS.contains(&key),
                "{key} is produced but not offered"
            );
        }
    }
}
