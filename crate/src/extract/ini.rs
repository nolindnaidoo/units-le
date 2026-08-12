//! INI, read with `rust-ini`.
//!
//! Escape processing is off and bare keys are dropped before parsing.
//! Both were found the hard way in the sibling crates: `\U` in a value
//! is a Windows path, not an escape, and one separator-less line used
//! to take every value in the file down with it.

use super::policy::Field;

fn options() -> ini::ParseOption {
    ini::ParseOption {
        enabled_escape: false,
        ..ini::ParseOption::default()
    }
}

/// Drop the unindented separator-less lines that `rust-ini` rejects. An
/// indented one continues the value above it and must survive.
fn without_bare_keys(text: &str) -> String {
    text.lines()
        .filter(|line| {
            let trimmed = line.trim();
            trimmed.is_empty()
                || line.starts_with(char::is_whitespace)
                || trimmed.starts_with(';')
                || trimmed.starts_with('#')
                || trimmed.starts_with('[')
                || trimmed.contains('=')
                || trimmed.contains(':')
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn extract(text: &str) -> Vec<Field> {
    let Ok(parsed) = ini::Ini::load_from_str_opt(&without_bare_keys(text), options()) else {
        return Vec::new();
    };
    parsed
        .iter()
        .flat_map(|(section, properties)| {
            properties.iter().map(move |(key, value)| Field {
                key: Some(match section {
                    Some(section) => format!("{section}.{key}"),
                    None => key.to_string(),
                }),
                text: value.to_string(),
            })
        })
        .collect()
}

pub(crate) fn parse_error(text: &str) -> Option<String> {
    ini::Ini::load_from_str_opt(&without_bare_keys(text), options())
        .err()
        .map(|error| format!("Failed to parse INI: {error}"))
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
    fn a_value_carries_its_section_and_its_key() {
        assert_eq!(
            fields("[server]\ntimeout = 30s"),
            [(Some("server.timeout".to_string()), "30s".to_string())]
        );
    }

    #[test]
    fn a_value_outside_a_section_is_keyed_by_name_alone() {
        assert_eq!(
            fields("timeout = 30s"),
            [(Some("timeout".to_string()), "30s".to_string())]
        );
    }

    /// Everything in an INI file is text, so a bare number arrives here
    /// as one. It is the grammar that decides it is not a quantity.
    #[test]
    fn a_bare_number_is_still_a_field_and_the_grammar_refuses_it() {
        assert_eq!(fields("[s]\nport = 8080")[0].1, "8080");
        assert!(crate::extract::grammar::read_value("8080").is_none());
    }

    #[test]
    fn comment_lines_are_skipped() {
        assert_eq!(fields("[s]\n; a = 1h\n# b = 2h\nc = 3h").len(), 1);
    }

    #[test]
    fn sections_are_walked_in_order() {
        assert_eq!(
            fields("[one]\na = 1h\n\n[two]\nb = 2h"),
            [
                (Some("one.a".to_string()), "1h".to_string()),
                (Some("two.b".to_string()), "2h".to_string()),
            ]
        );
    }

    #[test]
    fn a_bare_key_does_not_take_the_file_down_with_it() {
        assert_eq!(fields("[s]\ntimeout = 30s\nbarekey").len(), 1);
    }

    #[test]
    fn a_document_that_cannot_parse_yields_nothing_and_says_why() {
        assert!(fields("[unclosed").is_empty());
        assert!(parse_error("[unclosed").is_some());
        assert!(parse_error("[s]\na = 1h").is_none());
    }
}
