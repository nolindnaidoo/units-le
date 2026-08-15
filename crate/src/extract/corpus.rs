//! The corpus, embedded and run as unit tests.
//!
//! `fixtures/` is the crate's own contract with itself: a document, and
//! the exact rows this tool answers with. Embedding it means `cargo
//! test` on the published tarball runs every case, so whoever installed
//! this can check the claims in the README instead of trusting them.
//!
//! The ambiguity set is the half that matters. **Every case in
//! `ambiguous.yaml` must come back with a named reason**, and a test
//! asserts exactly that — because the failure this tool exists to
//! prevent is a case quietly starting to normalise.

/// One corpus document, by name. Panics on a name the corpus does not
/// carry — a test naming a file that is not there is a broken test, not
/// a runtime condition.
///
/// Compiled only for the tests that read it, rather than shipped and
/// held quiet by a `dead_code` relaxation: an inline lint attribute is
/// the one thing this crate does not carry, and the binary a user runs
/// has no reason to hold the corpus in its own text.
#[cfg(test)]
pub(crate) fn document(name: &str) -> &'static str {
    match name {
        "units.json" => include_str!("../../fixtures/documents/units.json"),
        "units.jsonc" => include_str!("../../fixtures/documents/units.jsonc"),
        "units.yaml" => include_str!("../../fixtures/documents/units.yaml"),
        "units.toml" => include_str!("../../fixtures/documents/units.toml"),
        "units.ini" => include_str!("../../fixtures/documents/units.ini"),
        "units.env" => include_str!("../../fixtures/documents/units.env"),
        "units.csv" => include_str!("../../fixtures/documents/units.csv"),
        "units.tsv" => include_str!("../../fixtures/documents/units.tsv"),
        "units.txt" => include_str!("../../fixtures/documents/units.txt"),
        "ambiguous.yaml" => include_str!("../../fixtures/documents/ambiguous.yaml"),
        // Not an expectation set: a page of opaque content whose rows
        // are all false findings by construction, so the text scan's
        // false-finding rate has a number. `fallback.rs` measures it.
        "opaque.txt" => include_str!("../../fixtures/documents/opaque.txt"),
        other => panic!("the corpus has no document named {other}"),
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::document;
    use crate::extract::grammar::Reason;
    use crate::extract::{Dimension, Format, Options, extract};

    const CORPUS: &str = include_str!("../../fixtures/extraction.json");

    #[derive(Debug, Deserialize)]
    struct Corpus {
        documents: Vec<Case>,
    }

    #[derive(Debug, Deserialize)]
    struct Case {
        name: String,
        file: String,
        #[serde(rename = "fileType")]
        file_type: Format,
        expected: Vec<Expected>,
        errors: Vec<String>,
    }

    /// One pinned row. Positions are not pinned here — they are unit
    /// tested in `locate.rs`, and pinning a column in the corpus would
    /// make every whitespace edit to a fixture a corpus change.
    #[derive(Debug, Deserialize, PartialEq, Eq)]
    struct Expected {
        value: String,
        dimension: Option<Dimension>,
        base: Option<String>,
        reason: Option<Reason>,
        key: Option<String>,
    }

    fn corpus() -> Corpus {
        serde_json::from_str(CORPUS).expect("the corpus is valid JSON")
    }

    fn rows(file: &str, file_type: Format) -> Vec<Expected> {
        extract(document(file), file_type, Options::default())
            .into_iter()
            .map(|found| Expected {
                value: found.quantity.value().to_string(),
                dimension: found.quantity.dimension(),
                base: found.quantity.answer().map(|(base, _)| base.to_string()),
                reason: found.quantity.reason(),
                key: found.key,
            })
            .collect()
    }

    #[test]
    fn every_corpus_document_reproduces() {
        let corpus = corpus();
        assert!(!corpus.documents.is_empty(), "the corpus is empty");
        for case in corpus.documents {
            assert!(case.errors.is_empty(), "{} pins an error", case.name);
            assert_eq!(
                rows(&case.file, case.file_type),
                case.expected,
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn the_corpus_covers_every_extractor() {
        let corpus = corpus();
        // Every variant, walked off the enum: a reader added without a
        // corpus document is a reader nothing pins the answers of.
        for format in Format::ALL {
            assert!(
                corpus.documents.iter().any(|case| case.file_type == format),
                "no corpus case reads {}",
                format.name()
            );
        }
    }

    /// The spine, asserted as a property rather than case by case: in
    /// the ambiguity set, nothing is silently normalised and nothing is
    /// dropped.
    #[test]
    fn every_case_in_the_ambiguity_set_is_reported_with_a_reason() {
        let found = extract(document("ambiguous.yaml"), Format::Yaml, Options::default());
        let lines = document("ambiguous.yaml").lines().count();
        assert_eq!(
            found.len(),
            lines,
            "the ambiguity set is one case per line, and none may be dropped"
        );
        for row in &found {
            assert!(
                row.quantity.reason().is_some(),
                "{} was resolved silently",
                row.quantity.value()
            );
        }
    }

    /// The one row in that set that keeps a base value, and the reason
    /// it does: SI is what the symbol says. If this ever becomes a
    /// refusal it is a behaviour change, not a tidy-up.
    #[test]
    fn only_the_si_hazard_carries_a_base_in_the_ambiguity_set() {
        let found = extract(document("ambiguous.yaml"), Format::Yaml, Options::default());
        let resolved: Vec<&str> = found
            .iter()
            .filter(|row| !row.quantity.is_refused())
            .map(|row| row.quantity.value())
            .collect();
        assert_eq!(resolved, ["1MB"]);
    }

    /// Every reason this tool can report has a corpus case pinning it,
    /// so the vocabulary cannot grow a value nothing checks.
    #[test]
    fn the_corpus_pins_every_reason() {
        let corpus = corpus();
        for reason in Reason::ALL {
            assert!(
                corpus
                    .documents
                    .iter()
                    .flat_map(|case| &case.expected)
                    .any(|row| row.reason == Some(reason)),
                "no corpus case pins {reason:?}"
            );
        }
    }

    /// And every dimension, so the four are all actually reachable
    /// through a real document rather than only through a unit test.
    #[test]
    fn the_corpus_pins_every_dimension() {
        let corpus = corpus();
        for dimension in Dimension::ALL {
            assert!(
                corpus
                    .documents
                    .iter()
                    .flat_map(|case| &case.expected)
                    .any(|row| row.dimension == Some(dimension)),
                "no corpus case pins {dimension:?}"
            );
        }
    }
}
