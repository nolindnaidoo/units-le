//! The tier that needs a document far larger than any editor opens.
//!
//! Gated behind `UNITS_LE_SCENARIOS`. Nothing here substitutes for the
//! unit tests, which run everywhere on every push.
//!
//! **A skipped scenario is never reported as a pass.**

use std::fmt::Write as _;
use std::io::Write as _;

fn enabled(name: &str) -> bool {
    if std::env::var_os("UNITS_LE_SCENARIOS").is_some() {
        return true;
    }
    eprintln!("SKIPPED {name}: set UNITS_LE_SCENARIOS to run it");
    false
}

fn scan(content: &str, format: &str) -> serde_json::Value {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_units-le"))
        .args(["--stdin", "--format", format])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            child
                .stdin
                .as_mut()
                .expect("stdin")
                .write_all(content.as_bytes())?;
            child.wait_with_output()
        })
        .expect("the binary runs");
    serde_json::from_slice(&output.stdout).expect("stdout carries JSON")
}

/// Locating is the operation that can go quadratic here: every value
/// searches forward through the document, and a shared cursor is what
/// keeps that linear. A spreadsheet export is the real shape and it is
/// all quantities.
#[test]
fn a_document_of_nothing_but_quantities_completes() {
    if !enabled("a_document_of_nothing_but_quantities_completes") {
        return;
    }
    let mut content = String::new();
    for row in 0..50_000 {
        let _ = writeln!(content, "{row}s,{row}MiB,{row}%");
    }
    let report = scan(&content, "csv");
    assert_eq!(report["summary"]["quantities"], 150_000);
    assert_eq!(report["summary"]["refused"], 0);
}

/// A minified or generated file is one very long line. Column lookup
/// counts UTF-16 units from the line start, which is what turns
/// quadratic when the line never ends.
#[test]
fn a_single_long_line_completes() {
    if !enabled("a_single_long_line_completes") {
        return;
    }
    let mut content = String::new();
    for index in 0..50_000 {
        let _ = write!(content, "ttl{index}={index}ms; ");
    }
    let report = scan(&content, "unknown");
    assert_eq!(report["summary"]["quantities"], 50_000);
}

/// The refusal path at scale. Every row is a quantity this tool will not
/// resolve, and none of them may be dropped to make the run cheaper.
#[test]
fn a_document_of_nothing_but_refusals_completes() {
    if !enabled("a_document_of_nothing_but_refusals_completes") {
        return;
    }
    let mut content = String::new();
    for index in 0..20_000 {
        let _ = writeln!(content, "k{index}: {index}m");
    }
    let report = scan(&content, "yaml");
    assert_eq!(report["summary"]["quantities"], 20_000);
    assert_eq!(
        report["summary"]["refused"], 20_000,
        "a bare `m` is refused however many times it appears"
    );
}
