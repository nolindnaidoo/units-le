//! YAML, read with `saphyr` — YAML 1.2 with the core schema.
//!
//! The schema matters more here than anywhere else: `timeout: 30s` is a
//! **string** scalar, because `30s` is not a YAML number, and that is
//! the only reason the most common way anyone writes a timeout is
//! readable at all. `timeout: 30` is an integer and is not a candidate.

use saphyr::{LoadableYamlNode, Scalar, Yaml};

use super::policy::{Field, Value, collect};

/// What a document is refused with when its directive runs off the end.
const UNBOUNDED: &str = "a directive runs to the end of the input with no line break after it";

/// How far past the end saphyr may read before the read is runaway. Its
/// own lookahead past the end is a handful of characters; the runaway one
/// never stops.
const OVERRUN: usize = 64;

/// The document's characters, then — where saphyr reads on past the end —
/// a line break that ends the read, and a note that it had to.
///
/// saphyr 0.1.0 pads the end of its input with `'\0'` and counts `'\0'` as
/// a non-space character, so a directive whose name or parameter runs to
/// the end of the input (`%YAML`, `a: 1\n%TAG`) is read for ever. This is
/// the only place the crate can see that happen, and what it read past the
/// end is not a document, so the load is refused rather than answered.
struct Bounded<'a> {
    chars: core::str::Chars<'a>,
    past_end: usize,
    overran: bool,
}

impl Iterator for Bounded<'_> {
    type Item = char;

    fn next(&mut self) -> Option<char> {
        if let Some(character) = self.chars.next() {
            return Some(character);
        }
        self.past_end += 1;
        if self.past_end.is_multiple_of(OVERRUN) {
            self.overran = true;
            return Some('\n');
        }
        None
    }
}

fn load(text: &str) -> Result<Vec<Yaml<'static>>, String> {
    let mut input = Bounded {
        chars: text.chars(),
        past_end: 0,
        overran: false,
    };
    let loaded = Yaml::load_from_iter(&mut input);
    if input.overran {
        return Err(UNBOUNDED.to_string());
    }
    loaded.map_err(|error| error.to_string())
}

pub(crate) fn extract(text: &str) -> Vec<Field> {
    let Ok(documents) = load(text) else {
        return Vec::new();
    };
    // A multi-document file is a sequence of documents, so a key in the
    // second one is `[1].timeout` — which says which document it came
    // from, and nothing else would.
    if let [single] = documents.as_slice() {
        return collect(&convert(single));
    }
    collect(&Value::Seq(documents.iter().map(convert).collect()))
}

fn convert(node: &Yaml<'_>) -> Value {
    match node {
        Yaml::Value(Scalar::String(text)) => Value::Text(text.to_string()),
        Yaml::Sequence(items) => Value::Seq(items.iter().map(convert).collect()),
        Yaml::Mapping(entries) => Value::Map(
            entries
                .iter()
                .map(|(key, value)| (key_of(key), convert(value)))
                .collect(),
        ),
        _ => Value::Other,
    }
}

/// A mapping key, where it is a plain scalar. A key that is itself a
/// sequence or a map is legal YAML and has no spelling here, so the
/// subtree under it reports no path rather than a made-up one.
fn key_of(node: &Yaml<'_>) -> Option<String> {
    match node {
        Yaml::Value(Scalar::String(text)) => Some(text.to_string()),
        Yaml::Value(Scalar::Integer(number)) => Some(number.to_string()),
        Yaml::Value(Scalar::Boolean(flag)) => Some(flag.to_string()),
        _ => None,
    }
}

pub(crate) fn parse_error(text: &str) -> Option<String> {
    load(text)
        .err()
        .map(|error| format!("Failed to parse YAML: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(text: &str) -> Vec<(Option<String>, String)> {
        extract(text)
            .into_iter()
            .map(|field| (field.key, field.text))
            .collect()
    }

    /// saphyr reads for ever past a directive that runs to the end of the
    /// input. Each of these hung the CLI and the MCP server before the
    /// bounded input; now each is refused by name, and a directive with
    /// its line break still reads.
    #[test]
    fn a_directive_that_runs_off_the_end_is_refused_rather_than_read_for_ever() {
        for text in ["%YAML", "a: 1\n%TAG", "%a: 1", "%FOO bar"] {
            assert!(fields(text).is_empty(), "{text:?}");
            assert_eq!(
                parse_error(text).as_deref(),
                Some(
                    "Failed to parse YAML: a directive runs to the end of the input with no line break after it"
                ),
                "{text:?}"
            );
        }
        assert_eq!(fields("%YAML 1.2\n---\na: 30s\n")[0].1, "30s");
        assert_eq!(parse_error("a: \"%TAG\""), None);
    }

    /// The property everything else here rests on.
    #[test]
    fn an_unquoted_quantity_is_a_string_and_a_bare_number_is_not() {
        assert_eq!(
            fields("timeout: 30s\nport: 8080"),
            [(Some("timeout".to_string()), "30s".to_string())]
        );
    }

    #[test]
    fn quoting_changes_nothing() {
        assert_eq!(fields("a: 30s")[0].1, "30s");
        assert_eq!(fields("a: \"30s\"")[0].1, "30s");
    }

    #[test]
    fn sequences_and_nesting_carry_their_path() {
        assert_eq!(
            fields("limits:\n  - 1h\n  - 7d\ncache:\n  ttl: 30s"),
            [
                (Some("limits[0]".to_string()), "1h".to_string()),
                (Some("limits[1]".to_string()), "7d".to_string()),
                (Some("cache.ttl".to_string()), "30s".to_string()),
            ]
        );
    }

    #[test]
    fn every_document_in_the_file_is_read_and_says_which() {
        assert_eq!(
            fields("a: 1h\n---\nb: 2h\n"),
            [
                (Some("[0].a".to_string()), "1h".to_string()),
                (Some("[1].b".to_string()), "2h".to_string()),
            ]
        );
    }

    #[test]
    fn a_broken_document_yields_nothing_and_says_why() {
        assert!(fields("a: [unterminated").is_empty());
        assert!(parse_error("a: [unterminated").is_some());
        assert!(parse_error("a: 1h").is_none());
    }
}
