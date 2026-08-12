//! YAML, read with `saphyr` — YAML 1.2 with the core schema.
//!
//! The schema matters more here than anywhere else: `timeout: 30s` is a
//! **string** scalar, because `30s` is not a YAML number, and that is
//! the only reason the most common way anyone writes a timeout is
//! readable at all. `timeout: 30` is an integer and is not a candidate.

use saphyr::{LoadableYamlNode, Scalar, Yaml};

use super::policy::{Field, Value, collect};

pub(crate) fn extract(text: &str) -> Vec<Field> {
    let Ok(documents) = Yaml::load_from_str(text) else {
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
    Yaml::load_from_str(text)
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
