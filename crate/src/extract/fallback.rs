//! Quantities in free-form text, for a format nothing here parses.
//!
//! **This scan has a grammar, and that is the difference from
//! numbers-le's.** A bare number can be anything, so its text scan
//! reads `v1.2.3` as `1.2` and `0.3`; a quantity has to be a number
//! welded to a unit symbol, which is a shape a scan can recognise. So
//! this is the extractor for a Kubernetes manifest, a Terraform file, a
//! Markdown table of limits and a log line — the files where quantities
//! actually live and where nobody names the format first.
//!
//! Two rules do the work:
//!
//! - **A run never begins inside a word.** The character before it must
//!   not be a letter, a digit, `_`, `.` or `,`, and the character after
//!   it must not be a letter, a digit or `_`. Without the first,
//!   `0x1d` reads as one day; without the second, `5Mac` reads as five
//!   mega-somethings.
//! - **An operator joins runs into one finding.** `1h + 30m` is
//!   consumed whole and refused as arithmetic, because reporting `1h`
//!   and `30m` separately is a true statement about the text and a
//!   false one about the value.
//!
//! What it still gets wrong is written down rather than left to be
//! found: a run inside an opaque blob reads as a quantity. `001d` in a
//! UUID is one day, and a base64 hash carrying `/2w=` is two weeks.
//!
//! **Measured, not imagined.** The characters that open a run — `-`,
//! `=`, `/`, `+`, `:`, a space, a quote — are exactly the ones that let
//! `-30s`, `ttl=30s` and `holds 512MiB.` through, and a UUID's `-` and a
//! base64 hash's `/` are the same characters, so a scan with no parser
//! cannot separate the cases. Narrowing the set would cost real findings
//! to remove false ones. Over `fixtures/documents/opaque.txt` — 280
//! lines of lockfile hashes, container digests, git object names, UUIDs
//! and signing material, none of it a quantity — the rate is **5
//! findings, 1.8%**, recomputed and printed by the test below. Every one
//! of them is reported with its line and column, which is what makes it
//! a row a reviewer discards rather than a number they trust.

use super::grammar::{self, Quantity, number_prefix, symbol_prefix};

/// Every quantity in the text, each with the byte offset of the run
/// that produced it.
pub(crate) fn scan(text: &str) -> Vec<(Quantity, usize)> {
    let mut found = Vec::new();
    let mut index = 0;

    while index < text.len() {
        let Some(character) = text[index..].chars().next() else {
            break;
        };
        let width = character.len_utf8();
        if !can_start(text, index) {
            index += width;
            continue;
        }
        let Some((quantity, consumed)) = candidate(text, index) else {
            index += width;
            continue;
        };
        found.push((quantity, index));
        index = consumed;
    }

    found
}

/// What the text at `index` yields, if anything.
///
/// The expression comes first: a run that is part of a sum is not a
/// quantity, and reporting it as one would be the whole failure. If the
/// wider slice turns out not to be an expression after all, the run
/// itself is still a finding.
///
/// **The chain may begin at a bare number**, which is the only way to
/// reach the quantity in `2*30s`. That start is speculative — it yields
/// nothing unless the chain it opens carries a unit somewhere, so a
/// date or a version keeps producing nothing.
fn candidate(text: &str, index: usize) -> Option<(Quantity, usize)> {
    let run = run_end(text, index);
    let first = run.or_else(|| number_end(text, index))?;

    let expression = expression_end(text, first)
        .and_then(|reach| Some((grammar::read_value(&text[index..reach])?, reach)));
    if let Some(found) = expression {
        return Some(found);
    }

    let end = run?;
    Some((grammar::read_value(&text[index..end])?, end))
}

/// Whether a run may begin at `index`: the character before it is not
/// part of a word, and the character at it can open one.
fn can_start(text: &str, index: usize) -> bool {
    if !boundary_before(text, index) {
        return false;
    }
    let mut characters = text[index..].chars();
    let Some(character) = characters.next() else {
        return false;
    };
    let next = characters.next();
    if character.is_ascii_digit() {
        return true;
    }
    if matches!(character, '+' | '-' | '.') {
        return next.is_some_and(|following| following.is_ascii_digit());
    }
    // An ISO-8601 duration is the one shape that opens with a letter.
    character == 'P' && next.is_some_and(|following| following.is_ascii_digit() || following == 'T')
}

fn boundary_before(text: &str, index: usize) -> bool {
    text[..index]
        .chars()
        .next_back()
        .is_none_or(|character| !word_character(character) && !matches!(character, '.' | ','))
}

fn boundary_after(text: &str, index: usize) -> bool {
    text[index..]
        .chars()
        .next()
        .is_none_or(|character| !word_character(character))
}

fn word_character(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

/// The end of the quantity-shaped run at `start`, if there is one and
/// it ends at a word boundary.
fn run_end(text: &str, start: usize) -> Option<usize> {
    let rest = &text[start..];
    let length = if rest.starts_with('P') {
        iso_run(rest)
    } else {
        plain_run(rest)
    }?;
    let end = start + length;
    boundary_after(text, end).then_some(end)
}

/// `number symbol` pairs, as many as follow each other. A trailing
/// number with no symbol is left out of the run, and the boundary check
/// then rejects the whole thing — `1h30` is a typo, not a duration.
fn plain_run(rest: &str) -> Option<usize> {
    let mut length = 0;
    let mut pairs = 0;
    loop {
        let number = number_prefix(&rest[length..], length == 0);
        if number == 0 {
            break;
        }
        let symbol = symbol_prefix(&rest[length + number..]);
        if symbol == 0 {
            break;
        }
        length += number + symbol;
        pairs += 1;
    }
    (pairs > 0).then_some(length)
}

/// `PT1H30M` — one word of digits, separators and designators. Whether
/// it is a duration is the grammar's decision, not the scanner's.
fn iso_run(rest: &str) -> Option<usize> {
    rest.char_indices()
        .take_while(|(_, character)| character.is_alphanumeric() || matches!(character, '.' | ','))
        .map(|(index, character)| index + character.len_utf8())
        .last()
}

/// How far an arithmetic expression starting with the run that ends at
/// `end` reaches, if it is one.
fn expression_end(text: &str, end: usize) -> Option<usize> {
    let mut reach = None;
    let mut cursor = end;
    loop {
        let after = skip_spaces(text, cursor);
        let Some(operator) = text[after..].chars().next() else {
            break;
        };
        if !matches!(operator, '+' | '-' | '*' | '/') {
            break;
        }
        let next_start = skip_spaces(text, after + operator.len_utf8());
        let Some(next_end) = operand_end(text, next_start) else {
            break;
        };
        cursor = next_end;
        reach = Some(next_end);
    }
    reach
}

/// How far the operand at `start` reaches: a quantity-shaped run, or a
/// bare number. The second is what keeps `30s*2` whole — the grammar
/// refuses the pair, and a reach that stopped at the operator would hand
/// it `30s` alone and call that the answer.
fn operand_end(text: &str, start: usize) -> Option<usize> {
    run_end(text, start).or_else(|| number_end(text, start))
}

/// The end of a plain number at `start`, if it ends at a word boundary.
fn number_end(text: &str, start: usize) -> Option<usize> {
    let length = number_prefix(&text[start..], false);
    if length == 0 {
        return None;
    }
    let end = start + length;
    boundary_after(text, end).then_some(end)
}

fn skip_spaces(text: &str, from: usize) -> usize {
    text[from..]
        .char_indices()
        .find(|(_, character)| !matches!(character, ' ' | '\t'))
        .map_or(text.len(), |(index, _)| from + index)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::grammar::Reason;

    fn values(text: &str) -> Vec<String> {
        scan(text)
            .into_iter()
            .map(|(quantity, _)| quantity.value().to_string())
            .collect()
    }

    fn bases(text: &str) -> Vec<Option<String>> {
        scan(text)
            .into_iter()
            .map(|(quantity, _)| quantity.answer().map(|(base, _)| base.to_string()))
            .collect()
    }

    #[test]
    fn quantities_are_found_in_prose() {
        assert_eq!(
            values("The cache holds 512MiB and expires after 1h30m."),
            ["512MiB", "1h30m"]
        );
        assert_eq!(
            bases("holds 512MiB for 1h30m"),
            [Some("536870912".to_string()), Some("5400000".to_string())]
        );
    }

    /// The grammar earning its place: numbers-le's scan reads this as
    /// two numbers, and this one reads it as nothing, because there is
    /// no unit in it.
    #[test]
    fn a_version_string_is_not_a_quantity() {
        assert!(values("Released v1.2.3 today").is_empty());
        assert!(values("rate 0.0825 on 1000 units").is_empty());
    }

    /// Without the leading-boundary rule this reads as one day.
    #[test]
    fn a_run_never_begins_inside_a_word() {
        assert!(values("mask 0x1d applied").is_empty());
        assert!(values("const u32 = 1").is_empty());
        assert!(values("sha256:ab12h34").is_empty());
    }

    /// Without the trailing-boundary rule this reads as five
    /// mega-somethings.
    #[test]
    fn a_run_never_ends_inside_a_word() {
        assert!(values("5Mac minis").is_empty());
        assert!(values("30seconds").is_empty());
        assert!(values("1h30 later").is_empty());
    }

    #[test]
    fn an_expression_is_one_finding_and_not_two() {
        let found = scan("timeout is 1h + 30m total");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0.value(), "1h + 30m");
        assert_eq!(found[0].0.reason(), Some(Reason::CompoundArithmetic));
    }

    /// **The run reaches the whole expression, so the refusal names
    /// what it saw.** The operand with no unit used to end the reach,
    /// which left the scan reporting `30s` — a true statement about
    /// three characters of the line and a false one about the value.
    #[test]
    fn the_scan_spans_an_expression_ending_in_a_bare_number() {
        for (text, expected) in [
            ("timeout is 30s*2 total", "30s*2"),
            ("wait 1h + 30 minutes", "1h + 30"),
            ("budget 30s / 4 shards", "30s / 4"),
        ] {
            let found = scan(text);
            assert_eq!(found.len(), 1, "{text}");
            assert_eq!(found[0].0.value(), expected, "{text}");
            assert_eq!(
                found[0].0.reason(),
                Some(Reason::CompoundArithmetic),
                "{text}"
            );
        }
    }

    /// And it stops where the expression does: a bare number that is not
    /// an operand must not extend a run, or every list of numbers after
    /// a quantity becomes one finding.
    #[test]
    fn a_bare_number_that_is_not_an_operand_does_not_extend_the_run() {
        assert_eq!(values("holds 512MiB, 2 copies"), ["512MiB"]);
        assert_eq!(values("holds 512MiB and 2 copies"), ["512MiB"]);
    }

    #[test]
    fn a_refusal_is_found_where_an_acceptance_would_be() {
        let found = scan("cpu: 500m and disk 1.5KB");
        assert_eq!(
            found
                .iter()
                .map(|(quantity, _)| quantity.reason())
                .collect::<Vec<_>>(),
            [Some(Reason::AmbiguousUnit), Some(Reason::FractionalBytes)]
        );
    }

    #[test]
    fn an_offset_points_at_the_run() {
        let text = "the cache holds 512MiB";
        let (quantity, offset) = scan(text).remove(0);
        assert_eq!(&text[offset..offset + quantity.value().len()], "512MiB");
    }

    #[test]
    fn a_thousands_group_is_not_split_into_two_findings() {
        let found = scan("budget 1,500ms");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0.value(), "1,500ms");
        assert_eq!(found[0].0.reason(), Some(Reason::LocaleSeparator));
    }

    #[test]
    fn an_iso_duration_is_found_by_its_leading_letter() {
        assert_eq!(values("retention PT1H30M applies"), ["PT1H30M"]);
        assert!(values("Pfoo bar").is_empty());
    }

    #[test]
    fn a_multibyte_character_does_not_shift_a_run() {
        let text = "café holds 512MiB";
        let (quantity, offset) = scan(text).remove(0);
        assert_eq!(&text[offset..offset + quantity.value().len()], "512MiB");
    }

    /// The documented false positive, asserted rather than left to be
    /// discovered. Both shapes are real: the first is a UUID, the second
    /// a base64 hash out of a lockfile.
    #[test]
    fn a_run_inside_an_opaque_blob_reads_as_a_quantity() {
        assert_eq!(values("id f47ac10b-001d-4f2a"), ["001d"]);
        assert_eq!(values("sha512-c3wKDVMkOuHPRHtSXKKU99IBazS/2w=="), ["2w"]);
    }

    /// **How often, not whether.** `fixtures/documents/opaque.txt` is
    /// 280 lines of the content a real repository is full of — lockfile
    /// integrity hashes, container digests, git object names, UUIDs,
    /// content-addressed asset names, signing material — generated once
    /// from a fixed seed and checked in. Nothing in it is a quantity, so
    /// every row the scan reports is a false one and the rate is
    /// arithmetic rather than an impression.
    ///
    /// Both bounds are deliberate. The ceiling fails a change that makes
    /// the scan noisier. The floor fails a change that makes it quieter
    /// — which would be welcome, and is a behaviour change that belongs
    /// in SPEC.md and the CHANGELOG rather than in a silently greener
    /// test. The third assertion is the one that keeps the *documents*
    /// honest: the rate is quoted in prose in two of them, and a number
    /// in prose is the half of a measurement that rots.
    #[test]
    fn the_false_finding_rate_over_opaque_content_is_measured_rather_than_imagined() {
        const SPEC: &str = include_str!("../../SPEC.md");
        const README: &str = include_str!("../../README.md");

        let document = crate::extract::corpus::document("opaque.txt");
        let opaque = document
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
            .count();
        let findings = scan(document);
        // Tenths of a percent, in integers, rounded rather than
        // truncated: a crate whose whole contract is that a base value
        // never goes through an `f64` does not reach for one to print
        // its own measurement either, and 5 in 280 is 1.8% to the tenth.
        let tenths = (findings.len() * 1000 + opaque / 2) / opaque;
        let rate = format!("{}.{}%", tenths / 10, tenths % 10);

        eprintln!(
            "opaque: {} false findings over {opaque} opaque tokens \u{2014} {rate}",
            findings.len()
        );
        for (quantity, _) in &findings {
            eprintln!("opaque:   {}", quantity.value());
        }

        assert!(
            findings.len() <= opaque / 20,
            "the text scan reports {} findings over {opaque} opaque tokens ({rate}), \
             above the 5% this crate documents",
            findings.len()
        );
        assert!(
            !findings.is_empty(),
            "the opaque-blob class is documented in SPEC.md and the README as a known \
             limitation; if it has been fixed, say so there rather than here"
        );
        for (name, document) in [("SPEC.md", SPEC), ("README.md", README)] {
            assert!(
                document.contains(&rate),
                "the measured rate is {rate} and {name} quotes another one — the number \
                 there is a claim about this measurement, not a note beside it"
            );
        }
    }

    #[test]
    fn text_with_nothing_quantitative_yields_nothing() {
        assert!(values("nothing quantitative on this line at all").is_empty());
        assert!(values("").is_empty());
    }
}
