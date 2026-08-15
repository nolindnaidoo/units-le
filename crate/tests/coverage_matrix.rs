//! Does this crate open what it claims to open, and answer what it
//! claims to answer?
//!
//! Three questions, all asked of the **built binary** over a real tree,
//! because a report line is the only proof a file was opened:
//!
//! - every extension the alias table names produces a report line, and
//!   so does a dozen it has never heard of — "an unrecognised format is
//!   a text scan, not a refusal" is the property the audit story rests
//!   on;
//! - every one of the six format readers yields a quantity from a
//!   document written for it;
//! - every `Dimension` and every `Reason` is reachable from a document
//!   on disk.
//!
//! **The enum sets come from `fixtures/extraction.json`, not from a list
//! typed here.** `extract/corpus.rs` already asserts the other
//! direction — that every `Reason::ALL` and every `Dimension::ALL` has a
//! corpus row — and serde refuses a corpus naming a value the enums do
//! not carry, so the two together make the corpus exactly the enums.
//! This file asks the remaining question: whether a caller running the
//! binary can reach each of them. Duplicating the enum lists here would
//! be a third place for them to drift.
//!
//! `extract/grammar.rs` carries the fourth leg — every unit spelling in
//! the pinned table, walked off the table itself.
//!
//! Every test prints a marker line and CI greps for it: `cargo test
//! <filter>` exits 0 when the filter matches nothing, so a renamed test
//! would pass the job silently.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

const BINARY: &str = env!("CARGO_BIN_EXE_units-le");
static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// The corpus, as the contract with itself. Read for the sets it names
/// rather than for its expectations, which `extract/corpus.rs` runs.
const CORPUS: &str = include_str!("../fixtures/extraction.json");

/// Every alias `extract/format.rs` maps, as the file extension a caller
/// would actually have. A new alias with no file here is an alias
/// nothing proves opens.
const ALIASES: [&str; 13] = [
    "json",
    "jsonc",
    "yaml",
    "yml",
    "csv",
    "tsv",
    "toml",
    "ini",
    "properties",
    "env",
    "dotenv",
    "editorconfig",
    "prometheus",
];

/// A dozen extensions the crate has never heard of. Each one must still
/// be read — as a text scan — because a reviewer points this at a
/// repository nobody has described to it, and a Kubernetes manifest or a
/// Terraform file is where quantities actually live.
const UNKNOWN: [&str; 12] = [
    "md",
    "txt",
    "log",
    "tf",
    "tfvars",
    "gradle",
    "dockerfile",
    "sh",
    "ps1",
    "rs",
    "ts",
    "py",
];

/// The six the tool schema offers, plus the fallback every unnamed file
/// falls to.
const FORMATS: [(&str, &str, &str); 7] = [
    ("json", "cache.json", "{\"ttl\":\"30s\"}\n"),
    ("yaml", "cache.yaml", "ttl: 30s\n"),
    ("toml", "cache.toml", "ttl = \"30s\"\n"),
    ("ini", "cache.ini", "[cache]\nttl = 30s\n"),
    ("env", "cache.env", "TTL=30s\n"),
    ("csv", "cache.csv", "30s,1h\n"),
    ("unknown", "NOTES.md", "the cache holds it for 30s\n"),
];

/// One document per reason and per dimension, so the whole vocabulary is
/// reachable through a file rather than only through a unit test.
const VOCABULARY: [(&str, &str); 2] = [
    (
        "dimensions.yaml",
        "ttl: 30s\nmemory: 512MiB\nshare: 15%\nrate: 60Hz\n",
    ),
    (
        "reasons.yaml",
        "cpu: 500m\ndisk: 1.5KB\nlatency: 1,5s\ntotal: 1h + 30m\nmemory: 1MB\n\
         capacity: 99999999999999999999999999999999999PiB\n",
    ),
];

struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new(name: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "units-le-matrix-{name}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a temporary directory");
        Self {
            root: std::fs::canonicalize(&root).expect("a canonical directory"),
        }
    }

    fn write(&self, relative: &str, contents: &str) {
        std::fs::write(self.root.join(relative), contents).expect("a file");
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn reports(target: &Path) -> Vec<serde_json::Value> {
    let output = Command::new(BINARY)
        .arg(target)
        .output()
        .expect("the binary runs");
    assert!(
        matches!(output.status.code(), Some(0 | 1)),
        "the walk did not finish: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("stdout carries only JSON"))
        .collect()
}

fn basename(report: &serde_json::Value) -> String {
    let file = report["file"].as_str().unwrap_or_default();
    file.rsplit(['/', '\\']).next().unwrap_or(file).to_string()
}

/// Every distinct value of one field across the whole corpus.
fn pinned(field: &str) -> BTreeSet<String> {
    let corpus: serde_json::Value = serde_json::from_str(CORPUS).expect("the corpus is valid JSON");
    corpus["documents"]
        .as_array()
        .expect("documents")
        .iter()
        .flat_map(|case| {
            case["expected"]
                .as_array()
                .expect("expectations")
                .iter()
                .filter_map(|row| row[field].as_str().map(str::to_string))
        })
        .collect()
}

/// A document that is readable in every one of these formats at once and
/// holds one quantity.
///
/// `# ttl 30s` is a comment in INI, TOML, YAML and dotenv; in CSV and
/// the text scan it is a row and a line; in JSON it is a parse failure,
/// which is a **warning** and still a report line. What matters is that
/// no format can refuse to open it, so a missing line means the file was
/// never read rather than that its content was wrong.
const READABLE: &str = "# ttl 30s\n";

/// **The list above is a hand copy, and a hand copy drifts.** The alias
/// table is `pub(crate)` inside a binary crate, so an integration test
/// cannot walk it; the declared length is what closes the gap. Add an
/// alias and this fails until a file for it is added here — which is the
/// only thing that proves the new extension is ever opened.
#[test]
fn the_alias_list_here_still_matches_the_table_it_copies() {
    const FORMAT_RS: &str = include_str!("../src/extract/format.rs");

    assert!(
        FORMAT_RS.contains(&format!(
            "const ALIASES: [(&str, Format); {}]",
            ALIASES.len()
        )),
        "extract/format.rs maps a different number of aliases than the {} named here",
        ALIASES.len()
    );
    for alias in ALIASES {
        assert!(
            FORMAT_RS.contains(&format!("(\"{alias}\", ")),
            "{alias} is named here and extract/format.rs does not map it"
        );
    }
}

#[test]
fn every_extension_the_alias_table_names_produces_a_report_line() {
    let tree = Tree::new("aliases");
    let mut expected: Vec<String> = Vec::new();
    for extension in ALIASES.into_iter().chain(UNKNOWN) {
        let name = format!("case.{extension}");
        tree.write(&name, READABLE);
        expected.push(name);
    }
    expected.sort();

    let scanned = reports(&tree.root);
    let mut named: Vec<String> = scanned.iter().map(basename).collect();
    named.sort();

    let missing: Vec<&String> = expected.iter().filter(|one| !named.contains(one)).collect();
    assert!(
        missing.is_empty(),
        "{} of {} files produced no report line: {missing:?}",
        missing.len(),
        expected.len()
    );
    assert_eq!(named, expected, "the walk reported a file nobody wrote");

    // A report line is not the same as a file that was read: a `skipped`
    // diagnostic is a line too, and none of these is unreadable.
    for report in &scanned {
        let diagnostics = report["diagnostics"].as_array().expect("diagnostics");
        assert!(
            diagnostics.iter().all(|one| one["code"] != "skipped"),
            "{} was reported as unread",
            basename(report)
        );
    }

    eprintln!(
        "coverage-matrix: {} extensions opened ({} aliased, {} unknown)",
        expected.len(),
        ALIASES.len(),
        UNKNOWN.len()
    );
}

/// Every format reader, reached the way a caller reaches it — a file on
/// disk with a name the tool resolves. A reader that resolves and then
/// finds nothing is a reader that is advertised and not implemented.
#[test]
fn every_format_reader_yields_a_quantity_from_a_real_document() {
    let tree = Tree::new("readers");
    for (_, name, body) in FORMATS {
        tree.write(name, body);
    }

    let scanned = reports(&tree.root);
    for (format, name, _) in FORMATS {
        let report = scanned
            .iter()
            .find(|report| basename(report) == name)
            .unwrap_or_else(|| panic!("{format}: no report line for {name}"));
        assert_eq!(report["format"], format, "{name} resolved elsewhere");
        assert_eq!(
            report["quantities"][0]["value"], "30s",
            "{format} opened {name} and read nothing out of it"
        );
        assert_eq!(report["quantities"][0]["base"], "30000", "{format}");
    }

    // The corpus reads the same seven, which is what makes each one's
    // expectations a contract rather than a smoke test.
    let corpus: serde_json::Value = serde_json::from_str(CORPUS).expect("the corpus is valid JSON");
    let covered: Vec<&str> = corpus["documents"]
        .as_array()
        .expect("documents")
        .iter()
        .filter_map(|case| case["fileType"].as_str())
        .collect();
    for (format, _, _) in FORMATS {
        assert!(
            covered.contains(&format),
            "{format} is read here and no corpus document pins what it answers"
        );
    }

    eprintln!(
        "coverage-matrix: {} format readers reachable from a real tree",
        FORMATS.len()
    );
}

/// Every dimension and every reason, reachable from a file. The expected
/// sets are the corpus's own, so this cannot fall behind the enums
/// without `extract/corpus.rs` failing first.
#[test]
fn every_dimension_and_every_reason_is_reachable_from_a_real_tree() {
    let tree = Tree::new("vocabulary");
    for (name, body) in VOCABULARY {
        tree.write(name, body);
    }

    let scanned = reports(&tree.root);
    let mut dimensions = BTreeSet::new();
    let mut reasons = BTreeSet::new();
    for report in &scanned {
        for row in report["quantities"].as_array().expect("rows") {
            if let Some(dimension) = row["dimension"].as_str() {
                dimensions.insert(dimension.to_string());
            }
            if let Some(reason) = row["reason"].as_str() {
                reasons.insert(reason.to_string());
            }
        }
    }

    let expected_dimensions = pinned("dimension");
    let expected_reasons = pinned("reason");
    assert_eq!(expected_dimensions.len(), 4, "the corpus lost a dimension");
    assert_eq!(expected_reasons.len(), 6, "the corpus lost a reason");
    assert_eq!(
        dimensions, expected_dimensions,
        "a dimension the corpus pins is not reachable from a file on disk"
    );
    assert_eq!(
        reasons, expected_reasons,
        "a reason the corpus pins is not reachable from a file on disk"
    );

    eprintln!(
        "coverage-matrix: {} dimensions and {} reasons reachable from a real tree",
        dimensions.len(),
        reasons.len()
    );
}
