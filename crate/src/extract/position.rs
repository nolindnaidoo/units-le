//! Byte offset → line/column, where **column is counted in UTF-16 code
//! units**.
//!
//! That is not an accident inherited from JavaScript. An editor reports
//! UTF-16 columns, so a person comparing this tool's output against the
//! file open in front of them needs the same number. Counting bytes
//! answers 6 where the correct answer is 5 on a line holding `café`, and
//! counting Unicode scalars answers 5 there but disagrees again on
//! anything astral.
//!
//! Lines and columns are 1-based.
//!
//! Each crate in this family stands on its own: no shared crate, no
//! published core, and nothing holding this file equal to the similar
//! ones in the sibling repos. Where they agree it is because the same
//! answer was right twice.

use std::cell::Cell;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct Position {
    pub(crate) line: usize,
    pub(crate) column: usize,
}

/// A prepared index over one document. Building it is O(bytes). A lookup
/// is a binary search, then a column: arithmetic when the document is
/// ASCII, and a UTF-16 count when it is not — counted on from the last
/// answer rather than from the line start.
pub(crate) struct PositionIndex<'a> {
    content: &'a str,
    /// Byte offset of the first character of each line.
    line_starts: Vec<usize>,
    /// Whether the whole document is ASCII, in which case a byte offset
    /// **is** a UTF-16 offset and a column is arithmetic rather than a
    /// scan.
    all_ascii: bool,
    /// The last non-ASCII answer: the line it was on, the offset asked
    /// for, and the code units counted to reach it.
    ///
    /// **This is the quadratic guard, and the ASCII fast path is not
    /// enough on its own.** ips-le found the shape the hard way: a
    /// column that re-counts from the line start on every lookup is
    /// invisible on ordinary source and quadratic on a minified file,
    /// where the whole document is one line. Both callers in
    /// `locate.rs` walk forward, so a lookup on the same line at or
    /// past the last one counts the gap instead of the prefix, and a
    /// document of *n* quantities costs one pass rather than *n*.
    /// Measured on one long non-ASCII line before the memo: four times
    /// the quantities cost 15.7x the clock.
    last: Cell<Memo>,
}

/// Where the previous non-ASCII lookup landed. `(line start, offset,
/// code units between them)` — a triple that is only ever read when the
/// first field matches, so a stale one cannot answer for the wrong line.
type Memo = (usize, usize, usize);

impl<'a> PositionIndex<'a> {
    pub(crate) fn new(content: &'a str) -> Self {
        let mut line_starts = vec![0];
        line_starts.extend(
            content
                .bytes()
                .enumerate()
                .filter(|&(_, byte)| byte == b'\n')
                .map(|(index, _)| index + 1),
        );
        Self {
            content,
            line_starts,
            all_ascii: content.is_ascii(),
            // Line one, offset zero, nothing counted: true of every
            // document, including the empty one.
            last: Cell::new((0, 0, 0)),
        }
    }

    /// The position of a byte offset. Offsets past the end clamp to the
    /// end, and an offset landing inside a multi-byte character floors
    /// to that character's start — neither can happen from a substring
    /// search, but a silently wrong column would be worse than a
    /// defensive floor.
    pub(crate) fn at(&self, offset: usize) -> Position {
        let clamped = self.floor_to_boundary(offset.min(self.content.len()));
        let line_index = self.line_starts.partition_point(|&start| start <= clamped) - 1;
        let line_start = self.line_starts[line_index];
        Position {
            line: line_index + 1,
            column: self.units_to(line_start, clamped) + 1,
        }
    }

    /// UTF-16 code units from a line start to an offset on that line.
    fn units_to(&self, line_start: usize, offset: usize) -> usize {
        if self.all_ascii {
            return offset - line_start;
        }
        let (memo_line, memo_offset, memo_units) = self.last.get();
        let (from, counted) = if memo_line == line_start && memo_offset <= offset {
            (memo_offset, memo_units)
        } else {
            (line_start, 0)
        };
        let units = counted + self.content[from..offset].encode_utf16().count();
        self.last.set((line_start, offset, units));
        units
    }

    fn floor_to_boundary(&self, mut offset: usize) -> usize {
        while offset > 0 && !self.content.is_char_boundary(offset) {
            offset -= 1;
        }
        offset
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_character_is_line_one_column_one() {
        assert_eq!(
            PositionIndex::new("abc").at(0),
            Position { line: 1, column: 1 }
        );
    }

    #[test]
    fn a_newline_starts_the_next_line() {
        let index = PositionIndex::new("ab\ncd");
        assert_eq!(index.at(3), Position { line: 2, column: 1 });
        assert_eq!(index.at(4), Position { line: 2, column: 2 });
    }

    #[test]
    fn an_empty_document_still_answers() {
        assert_eq!(
            PositionIndex::new("").at(0),
            Position { line: 1, column: 1 }
        );
    }

    #[test]
    fn an_offset_past_the_end_clamps() {
        assert_eq!(
            PositionIndex::new("ab").at(999),
            Position { line: 1, column: 3 }
        );
    }

    /// A two-byte character is one UTF-16 code unit, so the column after
    /// it advances by one, not two. Byte counting fails here — and this
    /// crate reads `µs`, so the case is not hypothetical.
    #[test]
    fn a_two_byte_character_counts_as_one_column() {
        assert_eq!(
            PositionIndex::new("µ!").at(2),
            Position { line: 1, column: 2 }
        );
    }

    /// An astral character is a surrogate pair: two UTF-16 code units
    /// from four bytes. Counting Unicode scalars fails here, which is
    /// why the rule is UTF-16 and not "characters".
    #[test]
    fn an_astral_character_counts_as_two_columns() {
        assert_eq!(
            PositionIndex::new("🎯!").at(4),
            Position { line: 1, column: 3 }
        );
    }

    #[test]
    fn an_offset_inside_a_character_floors_to_its_start() {
        assert_eq!(
            PositionIndex::new("µ!").at(1),
            Position { line: 1, column: 1 }
        );
    }

    /// The memo is an optimisation, so it has to be invisible. A shared
    /// index is asked for every offset in a document full of multi-byte
    /// characters — forwards, then backwards, then jumping between
    /// lines — and every answer must equal the one a fresh index gives,
    /// which counts from the line start with nothing remembered.
    #[test]
    fn the_memo_agrees_with_a_fresh_count_however_the_offsets_arrive() {
        let content =
            "caf\u{e9} 30s\n\u{1f3af} \u{4e2d}\u{6587} 1h\n\u{b5}s and \u{e9}\u{e9}\u{e9}";
        let shared = PositionIndex::new(content);
        let boundaries: Vec<usize> = (0..=content.len())
            .filter(|offset| content.is_char_boundary(*offset))
            .collect();

        let forwards = boundaries.iter().copied();
        let backwards = boundaries.iter().rev().copied();
        // Interleaved, so a lookup on line three is followed by one on
        // line one — the case where a remembered line is the wrong line.
        let interleaved = boundaries
            .iter()
            .copied()
            .zip(boundaries.iter().rev().copied())
            .flat_map(|(low, high)| [low, high]);

        for offset in forwards.chain(backwards).chain(interleaved) {
            assert_eq!(
                shared.at(offset),
                PositionIndex::new(content).at(offset),
                "at offset {offset}"
            );
        }
    }

    /// The fast path and the counted path must agree at every offset, or
    /// the optimisation is a second implementation with its own answers.
    #[test]
    fn the_ascii_fast_path_agrees_with_the_counted_path() {
        let ascii = "abc\ndef";
        let index = PositionIndex::new(ascii);
        assert!(index.all_ascii);
        for offset in 0..=ascii.len() {
            let line_index = index.line_starts.partition_point(|&start| start <= offset) - 1;
            let line_start = index.line_starts[line_index];
            assert_eq!(
                index.at(offset),
                Position {
                    line: line_index + 1,
                    column: ascii[line_start..offset].encode_utf16().count() + 1,
                },
                "at offset {offset}"
            );
        }
    }

    /// A carriage return is an ordinary character, not a line break.
    #[test]
    fn a_carriage_return_does_not_start_a_line() {
        let index = PositionIndex::new("a\r\nb");
        assert_eq!(index.at(1), Position { line: 1, column: 2 });
        assert_eq!(index.at(3), Position { line: 2, column: 1 });
    }
}
