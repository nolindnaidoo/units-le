//! JSON, read with `jsonc-parser`. Every loosening is off, so a file
//! this reads is a file `JSON.parse` reads.
//!
//! Only strings are candidates: `"timeout": "30s"` is a quantity and
//! `"timeout": 30` is a number with no unit, which is a different
//! tool's question.

use jsonc_parser::ast::{Object, Value as Node};
use jsonc_parser::{CollectOptions, ParseOptions, parse_to_ast};

use super::policy::{Field, Value, collect};

fn strict() -> ParseOptions {
    ParseOptions {
        allow_comments: false,
        allow_loose_object_property_names: false,
        allow_trailing_commas: false,
        allow_missing_commas: false,
        allow_single_quoted_strings: false,
        allow_hexadecimal_numbers: false,
        allow_unary_plus_numbers: false,
    }
}

pub(crate) fn extract(text: &str) -> Vec<Field> {
    collect(&parsed(text).unwrap_or(Value::Other))
}

fn parsed(text: &str) -> Option<Value> {
    let result = parse_to_ast(text, &CollectOptions::default(), &strict()).ok()?;
    result.value.as_ref().map(convert)
}

fn convert(node: &Node) -> Value {
    match node {
        Node::StringLit(literal) => Value::Text(literal.value.to_string()),
        Node::Array(array) => Value::Seq(array.elements.iter().map(convert).collect()),
        Node::Object(object) => convert_object(object),
        _ => Value::Other,
    }
}

fn convert_object(object: &Object) -> Value {
    Value::Map(
        object
            .properties
            .iter()
            .map(|property| {
                (
                    Some(property.name.as_str().to_string()),
                    convert(&property.value),
                )
            })
            .collect(),
    )
}

pub(crate) fn parse_error(text: &str) -> Option<String> {
    match parse_to_ast(text, &CollectOptions::default(), &strict()) {
        Err(error) => Some(format!("Failed to parse JSON: {error}")),
        // jsonc-parser reads an empty document as a successful parse of
        // nothing; `JSON.parse("")` throws, and a caller who asked for
        // JSON and handed over an empty file should hear about it.
        Ok(result) if result.value.is_none() => {
            Some("Failed to parse JSON: unexpected end of input".to_string())
        }
        Ok(_) => None,
    }
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

    #[test]
    fn a_string_value_is_a_candidate_and_a_number_is_not() {
        assert_eq!(
            fields(r#"{"timeout":"30s","port":8080}"#),
            [(Some("timeout".to_string()), "30s".to_string())]
        );
    }

    #[test]
    fn keys_are_never_read() {
        assert_eq!(fields(r#"{"timeout_30s":"none"}"#).len(), 1);
        assert_eq!(fields(r#"{"timeout_30s":"none"}"#)[0].1, "none");
    }

    #[test]
    fn nesting_is_followed_in_document_order_with_its_path() {
        assert_eq!(
            fields(r#"{"a":"1h","b":{"c":"2h","d":["3h"]}}"#),
            [
                (Some("a".to_string()), "1h".to_string()),
                (Some("b.c".to_string()), "2h".to_string()),
                (Some("b.d[0]".to_string()), "3h".to_string()),
            ]
        );
    }

    #[test]
    fn booleans_and_null_are_not_candidates() {
        assert!(fields(r#"{"a":true,"b":null}"#).is_empty());
    }

    #[test]
    fn a_broken_document_yields_nothing_and_says_why() {
        assert!(fields("{not json").is_empty());
        assert!(parse_error("{not json").is_some());
        assert!(parse_error(r#"{"a":"1h"}"#).is_none());
    }

    #[test]
    fn an_empty_document_is_a_parse_failure() {
        assert!(parse_error("").is_some());
        assert!(parse_error("   \n ").is_some());
        assert!(parse_error("{}").is_none());
    }

    #[test]
    fn the_loosenings_are_off() {
        assert!(parse_error(r#"{"a":"1h",}"#).is_some());
        assert!(parse_error("{'a':'1h'}").is_some());
    }
}
