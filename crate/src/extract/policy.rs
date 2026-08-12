//! The one rule every structured extractor shares: **a quantity is a
//! string value**.
//!
//! numbers-le splits its formats into typed and untyped, because there
//! the same text is data in JSON and a number in `.env`. Here there is
//! no such split, and the reason is worth stating: a unit is spelled out
//! in characters, so `30s` is a string in every one of these formats —
//! JSON cannot hold it any other way, and neither can TOML. A *typed*
//! value is the thing that is never a quantity: `timeout = 30` is a
//! number with no unit, which is numbers-le's question and not this
//! one's.
//!
//! Keys are never read, in any format. A key named `timeout_30s` is a
//! name, not a measurement.

/// One string value from a document, and the path that reaches it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Field {
    /// Dotted for maps, bracketed for sequences: `cache.ttl`,
    /// `limits[0]`. `None` where the format has no key path — CSV, the
    /// text scan — or where a key was not a string this can spell.
    pub(crate) key: Option<String>,
    pub(crate) text: String,
}

/// A parsed document, in the shape every parser here is normalised into.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Value {
    Text(String),
    /// A number, a boolean, a date — anything with a type of its own.
    /// Never a quantity: it has no room for a unit.
    Other,
    Seq(Vec<Value>),
    /// A key that this cannot spell — a YAML mapping keyed by a
    /// sequence — carries `None`, and everything under it loses its
    /// path rather than being given a made-up one.
    Map(Vec<(Option<String>, Value)>),
}

/// Every string in a document, in document order, with its path.
pub(crate) fn collect(value: &Value) -> Vec<Field> {
    let mut out = Vec::new();
    walk(value, Some(String::new()), &mut out);
    out
}

fn walk(value: &Value, path: Option<String>, out: &mut Vec<Field>) {
    match value {
        Value::Text(text) => out.push(Field {
            key: path.filter(|path| !path.is_empty()),
            text: text.clone(),
        }),
        Value::Other => {}
        Value::Seq(items) => {
            for (index, item) in items.iter().enumerate() {
                walk(item, path.as_ref().map(|at| format!("{at}[{index}]")), out);
            }
        }
        Value::Map(entries) => {
            for (key, item) in entries {
                walk(item, join(path.as_ref(), key.as_ref()), out);
            }
        }
    }
}

fn join(path: Option<&String>, key: Option<&String>) -> Option<String> {
    let (path, key) = (path?, key?);
    if path.is_empty() {
        return Some(key.clone());
    }
    Some(format!("{path}.{key}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> Value {
        Value::Text(value.to_string())
    }

    fn entry(key: &str, value: Value) -> (Option<String>, Value) {
        (Some(key.to_string()), value)
    }

    fn fields(value: &Value) -> Vec<(Option<String>, String)> {
        collect(value)
            .into_iter()
            .map(|field| (field.key, field.text))
            .collect()
    }

    #[test]
    fn a_top_level_string_is_keyed_by_its_name() {
        let document = Value::Map(vec![entry("timeout", text("30s"))]);
        assert_eq!(
            fields(&document),
            [(Some("timeout".to_string()), "30s".to_string())]
        );
    }

    #[test]
    fn nesting_is_walked_in_document_order_and_dotted() {
        let document = Value::Map(vec![
            entry("a", text("1h")),
            entry(
                "cache",
                Value::Map(vec![entry("ttl", text("30s")), entry("size", text("1MiB"))]),
            ),
        ]);
        assert_eq!(
            fields(&document),
            [
                (Some("a".to_string()), "1h".to_string()),
                (Some("cache.ttl".to_string()), "30s".to_string()),
                (Some("cache.size".to_string()), "1MiB".to_string()),
            ]
        );
    }

    #[test]
    fn a_sequence_is_indexed() {
        let document = Value::Map(vec![entry(
            "limits",
            Value::Seq(vec![text("1h"), text("7d")]),
        )]);
        assert_eq!(
            fields(&document),
            [
                (Some("limits[0]".to_string()), "1h".to_string()),
                (Some("limits[1]".to_string()), "7d".to_string()),
            ]
        );
    }

    /// A typed value has no room for a unit, so it is never a candidate.
    #[test]
    fn a_typed_value_is_not_a_candidate() {
        let document = Value::Map(vec![entry("port", Value::Other), entry("ttl", text("30s"))]);
        assert_eq!(
            fields(&document),
            [(Some("ttl".to_string()), "30s".to_string())]
        );
    }

    /// A path this cannot spell is reported as no path, never as a
    /// made-up one — and the subtree under it loses its path too.
    #[test]
    fn an_unspellable_key_poisons_the_path_below_it() {
        let document = Value::Map(vec![(None, Value::Map(vec![entry("ttl", text("30s"))]))]);
        assert_eq!(fields(&document), [(None, "30s".to_string())]);
    }

    #[test]
    fn a_document_that_is_one_sequence_indexes_from_the_root() {
        let document = Value::Seq(vec![text("30s")]);
        assert_eq!(
            fields(&document),
            [(Some("[0]".to_string()), "30s".to_string())]
        );
    }
}
