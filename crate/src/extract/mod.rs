pub(crate) mod corpus;
pub(crate) mod csv;
pub(crate) mod decimal;
pub(crate) mod dotenv;
pub(crate) mod fallback;
pub(crate) mod format;
pub(crate) mod grammar;
pub(crate) mod ini;
pub(crate) mod json;
pub(crate) mod locate;
pub(crate) mod policy;
pub(crate) mod position;
pub(crate) mod toml;
pub(crate) mod yaml;

use serde::Serialize;

pub(crate) use format::{FALLBACK_FORMAT, SUPPORTED_FORMATS, resolve_format};
pub(crate) use grammar::{Dimension, Quantity};
pub(crate) use position::Position;

/// What a caller can change about how a document is read.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Options {
    /// Report only one dimension.
    ///
    /// **A refusal that names no dimension survives every filter.** A
    /// bare `500m` could be a duration or a byte count — that is why it
    /// was refused — so filtering it out would be this tool deciding
    /// what it just said it could not decide.
    pub(crate) dimension: Option<Dimension>,
}

/// One quantity, where it was found, and what reaches it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Found {
    #[serde(flatten)]
    pub(crate) quantity: Quantity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) key: Option<String>,
    #[serde(flatten)]
    pub(crate) position: Option<Position>,
}

/// What reading a document produced, before positions.
///
/// The structured formats hand over whole values and are placed by
/// searching for them; the text scan is itself a scanner and already
/// knows where it matched.
pub(crate) enum Harvest {
    Fields(Vec<(Quantity, Option<String>)>),
    Runs(Vec<(Quantity, usize)>),
}

/// Every quantity in a document, in document order, with its key path
/// and — where it can be found — its position.
///
/// **There is one extraction function, and both surfaces use it.**
/// numbers-le's shared MCP tool omits positions to stay byte-identical
/// with its npm twin; this crate has no twin, so a second shape would
/// be two answers to one question.
pub(crate) fn extract(text: &str, format: &str, options: Options) -> Vec<Found> {
    let found = locate::locate(text, harvest(text, format));
    let Some(wanted) = options.dimension else {
        return found;
    };
    found
        .into_iter()
        .filter(|found| {
            found
                .quantity
                .dimension
                .is_none_or(|dimension| dimension == wanted)
        })
        .collect()
}

fn harvest(text: &str, format: &str) -> Harvest {
    let fields = match format::canonical(format) {
        "json" => json::extract(text),
        "yaml" => yaml::extract(text),
        "toml" => toml::extract(text),
        "ini" => ini::extract(text),
        "env" => dotenv::extract(text),
        "csv" => csv::extract(text),
        _ => return Harvest::Runs(fallback::scan(text)),
    };
    Harvest::Fields(
        fields
            .into_iter()
            .filter_map(|field| Some((grammar::read_value(&field.text)?, field.key)))
            .collect(),
    )
}

/// Why a document yielded nothing, when the reason is a parse failure.
pub(crate) fn parse_error(text: &str, format: &str) -> Option<String> {
    match format::canonical(format) {
        "json" => json::parse_error(text),
        "yaml" => yaml::parse_error(text),
        "toml" => toml::parse_error(text),
        "ini" => ini::parse_error(text),
        "csv" => csv::parse_error(text),
        // dotenv reads lines and the fallback scans runs; neither has a
        // shape it can reject.
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(text: &str, format: &str, options: Options) -> Vec<String> {
        extract(text, format, options)
            .into_iter()
            .map(|found| found.quantity.value)
            .collect()
    }

    fn plain(text: &str, format: &str) -> Vec<String> {
        values(text, format, Options::default())
    }

    #[test]
    fn every_format_reaches_its_extractor() {
        assert_eq!(plain(r#"{"a":"30s"}"#, "json"), ["30s"]);
        assert_eq!(plain("a: 30s", "yaml"), ["30s"]);
        assert_eq!(plain("a = \"30s\"", "toml"), ["30s"]);
        assert_eq!(plain("[s]\na = 30s", "ini"), ["30s"]);
        assert_eq!(plain("A=30s", "env"), ["30s"]);
        assert_eq!(plain("30s,1h", "csv"), ["30s", "1h"]);
        assert_eq!(plain("waits 30s here", "unknown"), ["30s"]);
    }

    #[test]
    fn a_key_path_is_carried_where_the_format_has_one() {
        let found = extract(r#"{"cache":{"ttl":"30s"}}"#, "json", Options::default());
        assert_eq!(found[0].key.as_deref(), Some("cache.ttl"));
        let scanned = extract("waits 30s", "unknown", Options::default());
        assert_eq!(scanned[0].key, None);
    }

    #[test]
    fn a_dimension_filter_keeps_only_that_dimension() {
        let document = "a: 30s\nb: 1MiB\nc: 15%\nd: 60Hz";
        let only = |dimension| {
            values(
                document,
                "yaml",
                Options {
                    dimension: Some(dimension),
                },
            )
        };
        assert_eq!(only(Dimension::Duration), ["30s"]);
        assert_eq!(only(Dimension::Bytes), ["1MiB"]);
        assert_eq!(only(Dimension::Percent), ["15%"]);
        assert_eq!(only(Dimension::Frequency), ["60Hz"]);
    }

    /// The rule the filter turns on: a refusal that names no dimension
    /// could belong to the one being asked for, so it is never dropped.
    #[test]
    fn a_refusal_with_no_dimension_survives_every_filter() {
        let document = "a: 500m\nb: 30s";
        for dimension in Dimension::ALL {
            assert!(
                values(
                    document,
                    "yaml",
                    Options {
                        dimension: Some(dimension)
                    }
                )
                .contains(&"500m".to_string()),
                "{dimension:?} dropped an unidentified refusal"
            );
        }
    }

    /// A refusal that *does* name a dimension filters like anything
    /// else — it is identified, just not resolved.
    #[test]
    fn a_refusal_that_names_a_dimension_filters_normally() {
        let kept = values(
            "a: 1.5KB\nb: 30s",
            "yaml",
            Options {
                dimension: Some(Dimension::Bytes),
            },
        );
        assert_eq!(kept, ["1.5KB"]);
    }

    #[test]
    fn a_bare_number_is_never_a_finding_in_any_format() {
        for (text, format) in [
            (r#"{"a":30}"#, "json"),
            ("a: 30", "yaml"),
            ("a = 30", "toml"),
            ("[s]\na = 30", "ini"),
            ("A=30", "env"),
            ("30,40", "csv"),
            ("the answer is 30", "unknown"),
        ] {
            assert!(plain(text, format).is_empty(), "{format}");
        }
    }

    #[test]
    fn a_parse_failure_is_reported_by_the_formats_that_can_have_one() {
        assert!(parse_error("{not json", "json").is_some());
        assert!(parse_error("a: [unterminated", "yaml").is_some());
        assert!(parse_error("not = = toml", "toml").is_some());
        assert!(parse_error("anything at all", "unknown").is_none());
        assert!(parse_error("A=30s", "env").is_none());
    }
}
