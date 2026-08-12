//! TOML, read with the `toml` crate at `preserve_order`.
//!
//! TOML has no unquoted string, so every quantity here is written
//! `ttl = "30s"`. `ttl = 30` is an integer and not a candidate.

use toml::Value as Toml;

use super::policy::{Field, Value, collect};

pub(crate) fn extract(text: &str) -> Vec<Field> {
    let Ok(parsed) = text.parse::<toml::Table>() else {
        return Vec::new();
    };
    collect(&convert_table(&parsed))
}

fn convert(value: &Toml) -> Value {
    match value {
        Toml::String(text) => Value::Text(text.clone()),
        Toml::Array(items) => Value::Seq(items.iter().map(convert).collect()),
        Toml::Table(entries) => convert_table(entries),
        _ => Value::Other,
    }
}

fn convert_table(table: &toml::Table) -> Value {
    Value::Map(
        table
            .iter()
            .map(|(key, value)| (Some(key.clone()), convert(value)))
            .collect(),
    )
}

pub(crate) fn parse_error(text: &str) -> Option<String> {
    text.parse::<toml::Table>()
        .err()
        .map(|error| format!("Failed to parse TOML: {error}"))
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
    fn a_quoted_quantity_is_a_candidate_and_a_bare_number_is_not() {
        assert_eq!(
            fields("ttl = \"30s\"\nport = 8080"),
            [(Some("ttl".to_string()), "30s".to_string())]
        );
    }

    #[test]
    fn tables_and_arrays_carry_their_path_in_document_order() {
        assert_eq!(
            fields("limits = [\"1h\", \"7d\"]\n\n[cache]\nttl = \"30s\"\n"),
            [
                (Some("limits[0]".to_string()), "1h".to_string()),
                (Some("limits[1]".to_string()), "7d".to_string()),
                (Some("cache.ttl".to_string()), "30s".to_string()),
            ]
        );
    }

    #[test]
    fn a_datetime_is_not_a_candidate() {
        assert!(fields("issued = 1979-05-27").is_empty());
    }

    #[test]
    fn a_broken_document_yields_nothing_and_says_why() {
        assert!(fields("not = = toml").is_empty());
        assert!(parse_error("not = = toml").is_some());
    }
}
