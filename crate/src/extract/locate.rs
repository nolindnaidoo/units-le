//! Finding where each quantity came from.
//!
//! Easier than in numbers-le, and for one reason: **a quantity is
//! reported as the text that produced it**. `512MiB` is printed exactly
//! as the document spells it, so the source can be found by searching
//! for it. numbers-le has to search by *value* — it prints `26` for
//! `0x1A` and `1e+21` for `1e21` — and pays for that with values it
//! cannot place at all.
//!
//! The search is forward-only, sharing one cursor down the document, so
//! two occurrences of `30s` take their own positions and a position can
//! never point above a quantity already reported.
//!
//! **A run is not always the value's source.** The search sees the whole
//! document, keys and comments included, so in `retry_30s = "30s"` the
//! value matches the digits in the key. The quantity is still right; the
//! position is a best effort. Narrowing it would need a
//! position-preserving parser per format, which is a large purchase for
//! a column.
//!
//! The text scan skips all of this: it is a scanner, so it already knows
//! where it matched.

use super::position::PositionIndex;
use super::{Found, Harvest};

pub(crate) fn locate(text: &str, harvest: Harvest) -> Vec<Found> {
    let index = PositionIndex::new(text);

    match harvest {
        Harvest::Runs(runs) => runs
            .into_iter()
            .map(|(quantity, offset)| Found {
                quantity,
                key: None,
                position: Some(index.at(offset)),
            })
            .collect(),
        Harvest::Fields(fields) => {
            let mut cursor = 0;
            fields
                .into_iter()
                .map(|(quantity, key)| {
                    let position = text[cursor..].find(&quantity.value).map(|offset| {
                        let at = cursor + offset;
                        cursor = at + quantity.value.len();
                        index.at(at)
                    });
                    Found {
                        quantity,
                        key,
                        position,
                    }
                })
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::extract::{Options, extract};

    fn at(text: &str, format: &str) -> Vec<Option<(usize, usize)>> {
        extract(text, format, Options::default())
            .into_iter()
            .map(|found| found.position.map(|at| (at.line, at.column)))
            .collect()
    }

    #[test]
    fn a_quantity_is_found_where_it_appears() {
        assert_eq!(at("ttl = \"30s\"\n", "toml"), [Some((1, 8))]);
    }

    /// The reason the cursor exists: two of the same value take their
    /// own occurrences.
    #[test]
    fn repeated_values_take_successive_occurrences() {
        let text = "a: 30s\nb: 1h\nc: 30s\n";
        assert_eq!(at(text, "yaml"), [Some((1, 4)), Some((2, 4)), Some((3, 4))]);
    }

    /// The limitation, asserted rather than left to be discovered: a key
    /// carrying the same text takes the match.
    #[test]
    fn a_run_in_a_key_can_take_the_match() {
        assert_eq!(at("retry_30s: 30s\n", "yaml"), [Some((1, 7))]);
    }

    /// The scan places its own runs, so a quantity in prose is exact.
    #[test]
    fn the_text_scan_places_its_own_runs() {
        assert_eq!(at("cache holds 512MiB today", "unknown"), [Some((1, 13))]);
    }

    /// A value the parser spelled differently from its source — a JSON
    /// escape — reports no position rather than a wrong one.
    #[test]
    fn a_value_the_search_cannot_find_reports_no_position() {
        assert_eq!(at("A=\"30s\"\nB=1h\n", "env"), [Some((1, 4)), Some((2, 3))]);
        assert_eq!(at(r#"{"a":"30\u0073"}"#, "json"), [None]);
    }

    /// Columns are UTF-16 units, so a quantity after a multi-byte
    /// character lands where an editor puts it.
    #[test]
    fn a_column_after_a_multibyte_character_is_counted_in_utf16() {
        assert_eq!(at("café: 30s\n", "yaml"), [Some((1, 7))]);
    }

    #[test]
    fn nothing_to_locate_is_nothing_returned() {
        assert!(at("", "toml").is_empty());
    }
}
