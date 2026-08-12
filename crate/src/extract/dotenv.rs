//! `.env`, line by line — the one format with no library.

use super::policy::Field;

pub(crate) fn extract(text: &str) -> Vec<Field> {
    text.lines().filter_map(field_of).collect()
}

fn field_of(raw_line: &str) -> Option<Field> {
    let line = raw_line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let content = line.strip_prefix("export ").map_or(line, str::trim);
    let (key, raw_value) = content.split_once('=')?;
    Some(Field {
        key: Some(key.trim().to_string()),
        text: unquote(strip_inline_comment(raw_value.trim())).to_string(),
    })
}

/// A `#` inside a quoted value is part of the value, which is the whole
/// reason quoting exists in these files.
fn strip_inline_comment(value: &str) -> &str {
    if value.starts_with('"') || value.starts_with('\'') {
        return value;
    }
    value
        .split_once('#')
        .map_or(value, |(before, _)| before.trim())
}

fn unquote(value: &str) -> &str {
    for quote in ['"', '\''] {
        if value.len() > 1 && value.starts_with(quote) && value.ends_with(quote) {
            return &value[1..value.len() - 1];
        }
    }
    value
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
    fn a_value_is_keyed_by_its_variable() {
        assert_eq!(
            fields("TIMEOUT=30s"),
            [(Some("TIMEOUT".to_string()), "30s".to_string())]
        );
    }

    #[test]
    fn comments_and_blank_lines_are_skipped() {
        assert_eq!(fields("# A=1h\n\nB=2h\n   \nC=3h").len(), 2);
    }

    #[test]
    fn an_export_prefix_is_removed() {
        assert_eq!(
            fields("export TIMEOUT=30s")[0].0,
            Some("TIMEOUT".to_string())
        );
    }

    #[test]
    fn quotes_are_removed_before_the_grammar_sees_the_value() {
        assert_eq!(fields("A=\"30s\"\nB='1h'")[0].1, "30s");
        assert_eq!(fields("A=\"30s\"\nB='1h'")[1].1, "1h");
    }

    #[test]
    fn an_inline_comment_ends_an_unquoted_value() {
        assert_eq!(fields("A=30s # the read timeout")[0].1, "30s");
    }

    #[test]
    fn a_line_with_no_separator_is_not_a_field() {
        assert!(fields("JUST_A_NAME").is_empty());
    }
}
