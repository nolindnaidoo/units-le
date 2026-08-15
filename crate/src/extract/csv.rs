//! CSV, read with the `csv` crate.
//!
//! **Every row is data.** There is no header inference: a header row of
//! column names simply yields no quantities, which is the right answer
//! for a row of names, and inferring one would silently drop a real row
//! from a file that has no header.
//!
//! A cell has no key path. The row and column are already in the line
//! and column of the position, and a made-up `row2.col3` would be a
//! second, worse spelling of the same fact.

use super::policy::Field;

fn rows(text: &str, delimiter: u8) -> Result<Vec<Vec<String>>, String> {
    csv::ReaderBuilder::new()
        .has_headers(false)
        .delimiter(delimiter)
        // A ragged row is data, not a failure.
        .flexible(true)
        .from_reader(text.as_bytes())
        .records()
        .map(|record| {
            record
                .map(|row| row.iter().map(str::to_string).collect())
                .map_err(|error| format!("Failed to parse CSV: {error}"))
        })
        .collect()
}

/// The byte between cells. Tab-separated files are the same grammar with
/// a different one, and reading them with a comma made every row a single
/// cell — which is never a quantity, so the file reported clean.
pub(crate) const COMMA: u8 = b',';
pub(crate) const TAB: u8 = b'\t';

pub(crate) fn extract(text: &str, delimiter: u8) -> Vec<Field> {
    let Ok(rows) = rows(text, delimiter) else {
        return Vec::new();
    };
    rows.into_iter()
        .flatten()
        .map(|cell| Field {
            key: None,
            text: cell,
        })
        .collect()
}

pub(crate) fn parse_error(text: &str, delimiter: u8) -> Option<String> {
    rows(text, delimiter).err()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cells(text: &str) -> Vec<String> {
        extract(text, COMMA)
            .into_iter()
            .map(|field| field.text)
            .collect()
    }

    fn tab_cells(text: &str) -> Vec<String> {
        extract(text, TAB)
            .into_iter()
            .map(|field| field.text)
            .collect()
    }

    #[test]
    fn every_cell_is_a_candidate_and_none_carries_a_key() {
        assert_eq!(cells("30s,1MiB\n1h,2GB"), ["30s", "1MiB", "1h", "2GB"]);
        assert!(
            extract("30s", COMMA)
                .iter()
                .all(|field| field.key.is_none())
        );
    }

    /// The delimiter is the whole difference. Read with a comma, a tab
    /// row is one cell — never a quantity — so the file reported clean.
    #[test]
    fn a_tab_row_is_cells_under_tab_and_one_cell_under_comma() {
        assert_eq!(tab_cells("id\tttl\n1\t30s"), ["id", "ttl", "1", "30s"]);
        assert_eq!(cells("id\tttl\n1\t30s"), ["id\tttl", "1\t30s"]);
        // And the reverse, so neither delimiter is quietly reading both.
        assert_eq!(tab_cells("30s,1h"), ["30s,1h"]);
    }

    #[test]
    fn the_first_row_is_data_like_any_other() {
        assert_eq!(cells("id,ttl\n1,30s"), ["id", "ttl", "1", "30s"]);
    }

    #[test]
    fn a_quoted_cell_may_contain_the_delimiter() {
        assert_eq!(cells("\"1h, 30m\",2h"), ["1h, 30m", "2h"]);
    }

    #[test]
    fn ragged_rows_are_data_not_failure() {
        assert_eq!(cells("30s,1h,2h\n7d"), ["30s", "1h", "2h", "7d"]);
        assert!(parse_error("30s,1h,2h\n7d", COMMA).is_none());
    }

    /// Pinned because it is surprising, and because the surprise is the
    /// reader's rather than this crate's: `csv` treats end-of-file as
    /// closing an open quote, so a truncated file is read as data and
    /// reports no error. Detecting it would mean writing a second CSV
    /// lexer to disagree with the first.
    #[test]
    fn an_unterminated_quote_is_read_to_the_end_of_the_file() {
        assert_eq!(cells("30s,\"1h"), ["30s", "1h"]);
        assert!(parse_error("30s,\"1h", COMMA).is_none());
    }
}
