//! One file end to end — the only path either surface calls.
//!
//! `cli.rs` and `mcp/` both come through here, so a rule can only be
//! written once. `tests/contracts.rs` asserts the two agree.

use std::path::Path;

use serde::Serialize;

use crate::extract::{self, Found, Options, resolve_format};

/// The report shape's version. Bumped when a field moves, so a script
/// reading these can branch instead of guessing.
const SCHEMA: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Diagnostic {
    pub(crate) severity: String,
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct Summary {
    /// Every row, refusals included. A refusal is a quantity that was
    /// found; what is missing is the base value, not the finding.
    pub(crate) quantities: usize,
    /// How many of those carry no base value.
    ///
    /// Reported rather than inferred, because it is the number that
    /// says how much of this report is an answer and how much is a
    /// question. A silent zero and a silent forty look identical.
    pub(crate) refused: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct FileReport {
    pub(crate) schema: u32,
    pub(crate) file: String,
    pub(crate) format: String,
    pub(crate) quantities: Vec<Found>,
    pub(crate) diagnostics: Vec<Diagnostic>,
    pub(crate) summary: Summary,
}

impl FileReport {
    /// Whether this file was not read at all — not text, or not
    /// openable.
    ///
    /// Reported rather than swallowed, because a report that quietly
    /// skipped a file would be claiming coverage it does not have. It
    /// does **not** fail the run on its own: every repository has a PNG
    /// and a zip in it, and exiting 2 on those makes the tool unusable
    /// in CI, which is the one place it is most worth running.
    pub(crate) fn was_skipped(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "skipped")
    }

    /// Whether the scan of this file gave up part way. Unlike a skip
    /// this **does** fail the run: reporting no findings for a file
    /// that was never finished would overstate coverage, which is the
    /// one thing an audit tool must never do.
    pub(crate) fn is_incomplete(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == "error")
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ScanOptions {
    pub(crate) extract: Options,
    /// A format the caller forced, instead of one inferred per file.
    pub(crate) format: Option<&'static str>,
}

/// What reading one file produced.
///
/// **A binary file is not a report.** It was never a text candidate —
/// every repository holds a PNG — and reporting it as a file that could
/// not be read makes `--strict` exit 2 on any tree containing an image.
/// It is counted instead, so the reader still knows coverage was
/// narrower than the tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Scanned {
    Read(Box<FileReport>),
    Binary,
}

impl Scanned {
    pub(crate) fn into_report(self) -> Option<FileReport> {
        match self {
            Self::Read(report) => Some(*report),
            Self::Binary => None,
        }
    }
}

/// Split what a walk produced into the reports and the count of files
/// that were never text. Both surfaces come through here so neither can
/// grow its own idea of what a binary file is.
pub(crate) fn partition(scanned: Vec<Scanned>) -> (Vec<FileReport>, usize) {
    let binary = scanned
        .iter()
        .filter(|one| **one == Scanned::Binary)
        .count();
    let reports = scanned
        .into_iter()
        .filter_map(Scanned::into_report)
        .collect();
    (reports, binary)
}

/// ripgrep's heuristic, and deliberately the same one: a NUL byte in the
/// first 8 KiB means binary.
const BINARY_SNIFF_BYTES: usize = 8192;

fn is_binary(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .take(BINARY_SNIFF_BYTES)
        .any(|byte| *byte == b'\0')
}

/// The path as the report spells it: **separated by `/` on every
/// platform**.
///
/// A report is diffed against one produced on another machine and read
/// by someone who does not have the tree. envsync-le shipped `\` on
/// Windows for a release, which made every path in a Windows report
/// differ from the same path in a Linux one for no reason a reader could
/// see.
#[cfg(windows)]
fn report_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// The path as the report spells it. Nothing to rewrite here: `\` is a
/// legal character in a Unix filename, and replacing it would rename the
/// file in the report.
#[cfg(not(windows))]
fn report_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

pub(crate) fn scan_file(path: &Path, options: ScanOptions) -> Scanned {
    let file = report_path(path);
    let format = options.format.unwrap_or_else(|| format_of(path));

    match std::fs::read(path) {
        Ok(bytes) if is_binary(&bytes) => Scanned::Binary,
        Ok(bytes) => Scanned::Read(Box::new(match String::from_utf8(bytes) {
            Ok(content) => scan_content(without_bom(&content), file, format, options),
            // Named rather than dropped. A file that looked like text
            // and was not is a file the reader would otherwise believe
            // was covered.
            Err(_) => skipped(file, format, "not UTF-8 text"),
        })),
        Err(error) => Scanned::Read(Box::new(skipped(file, format, &error.to_string()))),
    }
}

fn format_of(path: &Path) -> &'static str {
    resolve_format(None, path.file_name().and_then(|name| name.to_str()))
}

pub(crate) fn scan_content(
    content: &str,
    file: String,
    format: &str,
    options: ScanOptions,
) -> FileReport {
    let quantities = extract::extract(content, format, options.extract);

    let mut diagnostics = Vec::new();
    // A parse failure yields nothing and says why. A warning rather than
    // an error because the document is unreadable *as that format*,
    // which is a fact about the file and not a failure of the run.
    if let Some(message) = extract::parse_error(content, format) {
        diagnostics.push(Diagnostic {
            severity: "warning".to_string(),
            code: "unparsed".to_string(),
            message,
        });
    }

    let refused = quantities
        .iter()
        .filter(|found| found.quantity.is_refused())
        .count();

    FileReport {
        schema: SCHEMA,
        file,
        format: format.to_string(),
        summary: Summary {
            quantities: quantities.len(),
            refused,
        },
        quantities,
        diagnostics,
    }
}

/// grep's convention: 0 found, 1 none found, 2 could not answer.
///
/// **A refusal does not change the exit code.** It is a finding, and a
/// tree full of ambiguous units is a real result that `if units-le
/// config/; then` has to see as success. `--strict` is for the pipeline
/// that wants every quantity resolved or the build stopped.
pub(crate) fn exit_code(reports: &[FileReport], strict: bool) -> u8 {
    // A scan that gave up part way always fails: it would otherwise
    // report "nothing found" for a file it never finished reading.
    if reports.iter().any(FileReport::is_incomplete) {
        return 2;
    }
    if strict
        && reports
            .iter()
            .any(|report| report.was_skipped() || report.summary.refused > 0)
    {
        return 2;
    }
    u8::from(!reports.iter().any(|report| report.summary.quantities > 0))
}

/// One finding, for the human half. The base value is the point, so it
/// comes first after the text; a refusal says so where the base would
/// have been.
pub(crate) fn describe(report: &FileReport, found: &Found) -> String {
    let at = match found.position {
        Some(position) => format!("{}:{}:{}", report.file, position.line, position.column),
        None => format!("{}:-", report.file),
    };
    // Two arms, because a base value and its unit arrive together or
    // not at all. There is no third state to write a line for.
    let answer = match found.quantity.answer() {
        Some((base, unit)) => format!("{base} {}", unit.name()),
        None => format!("refused: {}", reason_of(found)),
    };
    format!("{at}  {}  {answer}", found.quantity.value())
}

/// The reason, as the report spells it. Serialising the enum is what
/// keeps the human line and the JSON from drifting into two vocabularies.
///
/// The fallback is unreachable: a row with no base value is built by
/// `Quantity::refused`, which always names one. It is a word rather than
/// a panic because a human summary line is not worth aborting an audit
/// over.
fn reason_of(found: &Found) -> String {
    found
        .quantity
        .reason()
        .and_then(|reason| serde_json::to_value(reason).ok())
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

/// The report for a file that was not read: named, warned about, and
/// not a failure by itself.
fn skipped(file: String, format: &'static str, reason: &str) -> FileReport {
    FileReport {
        schema: SCHEMA,
        file,
        format: format.to_string(),
        quantities: Vec::new(),
        diagnostics: vec![Diagnostic {
            severity: "warning".to_string(),
            code: "skipped".to_string(),
            message: reason.to_string(),
        }],
        summary: Summary {
            quantities: 0,
            refused: 0,
        },
    }
}

/// Drop a leading byte-order mark.
///
/// Three invisible bytes that Notepad, Excel and a PowerShell redirect
/// all add. They shift every column on the first line, and in a
/// structured format they can lose the document entirely — which is
/// indistinguishable from a file with no quantities in it.
pub(crate) fn without_bom(content: &str) -> &str {
    content.strip_prefix('\u{feff}').unwrap_or(content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::Dimension;
    use crate::testing::TempTree;

    fn plain() -> ScanOptions {
        ScanOptions::default()
    }

    fn read(path: &Path, options: ScanOptions) -> FileReport {
        scan_file(path, options)
            .into_report()
            .expect("the file was a text candidate")
    }

    fn values(report: &FileReport) -> Vec<&str> {
        report
            .quantities
            .iter()
            .map(|found| found.quantity.value())
            .collect()
    }

    #[test]
    fn a_document_with_quantities_exits_zero() {
        let report = scan_content(r#"{"ttl":"30s"}"#, "a.json".into(), "json", plain());
        assert_eq!(values(&report), ["30s"]);
        assert_eq!(report.summary.quantities, 1);
        assert_eq!(exit_code(&[report], false), 0);
    }

    #[test]
    fn a_document_with_none_exits_one() {
        let report = scan_content(r#"{"a":"text"}"#, "a.json".into(), "json", plain());
        assert_eq!(report.summary.quantities, 0);
        assert_eq!(exit_code(&[report], false), 1);
    }

    #[test]
    fn nothing_to_scan_exits_one() {
        assert_eq!(exit_code(&[], false), 1);
    }

    /// A refusal is a finding: the file had quantities in it, and this
    /// tool read them and would not resolve two.
    #[test]
    fn a_refusal_is_counted_and_does_not_fail_the_run() {
        let report = scan_content(
            "a: 500m\nb: 1.5KB\nc: 30s",
            "a.yaml".into(),
            "yaml",
            plain(),
        );
        assert_eq!(report.summary.quantities, 3);
        assert_eq!(report.summary.refused, 2);
        assert_eq!(exit_code(std::slice::from_ref(&report), false), 0);
        assert_eq!(exit_code(&[report], true), 2, "--strict is opt-in");
    }

    /// The hazard row has a base, so it is not a refusal and does not
    /// trip `--strict`. Whether it should is exactly the argument this
    /// distinction exists to settle.
    #[test]
    fn an_si_hazard_is_not_a_refusal() {
        let report = scan_content("a: 1MB", "a.yaml".into(), "yaml", plain());
        assert_eq!(report.summary.refused, 0);
        assert_eq!(
            report.quantities[0].quantity.answer().map(|(base, _)| base),
            Some("1000000")
        );
        assert_eq!(exit_code(&[report], true), 0);
    }

    /// A broken document is a fact about that file, not a failed run.
    /// One malformed config must not fail an audit of ten thousand.
    #[test]
    fn a_parse_failure_is_a_warning_not_an_exit_two() {
        let report = scan_content("{not json", "a.json".into(), "json", plain());
        assert_eq!(report.diagnostics.len(), 1);
        assert_eq!(report.diagnostics[0].severity, "warning");
        assert!(!report.was_skipped());
        assert_eq!(exit_code(&[report], false), 1);
    }

    #[test]
    fn an_unreadable_file_is_reported_and_does_not_end_the_run() {
        let tree = TempTree::new("scan-unreadable");
        let report = read(&tree.path().join("gone.json"), plain());
        assert!(report.was_skipped());
        assert_eq!(report.diagnostics[0].severity, "warning");
        assert_eq!(exit_code(std::slice::from_ref(&report), false), 1);
        assert_eq!(exit_code(&[report], true), 2, "--strict is opt-in");
    }

    #[test]
    fn a_binary_file_is_not_a_report() {
        let tree = TempTree::new("scan-binary");
        let file = tree.write_bytes("logo.png", &[0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]);
        assert_eq!(scan_file(&file, plain()), Scanned::Binary);
    }

    /// The distinction the split exists for: a file that *is* text and
    /// could not be read keeps its named diagnostic and keeps failing
    /// `--strict`. A PNG beside it does neither.
    #[test]
    fn a_text_file_that_cannot_be_read_still_fails_strict_and_a_binary_one_does_not() {
        let tree = TempTree::new("scan-strict");
        let binary = tree.write_bytes("logo.png", &[0x89, 0x50, 0x00, 0xff]);
        // Invalid UTF-8 with no NUL byte: it looked like text and was not.
        let broken = tree.write_bytes("notes.txt", &[0x68, 0x69, 0xff, 0xfe]);
        let good = tree.write("limits.env", "TTL=30s\n");

        let (reports, binaries) = partition(vec![
            scan_file(&binary, plain()),
            scan_file(&broken, plain()),
            scan_file(&good, plain()),
        ]);
        assert_eq!(binaries, 1);
        assert_eq!(reports.len(), 2, "the PNG produced no report line");
        assert_eq!(reports[0].diagnostics[0].message, "not UTF-8 text");

        assert_eq!(
            exit_code(&reports, false),
            0,
            "the .env file has a quantity"
        );
        assert_eq!(exit_code(&reports, true), 2, "the unreadable text file");
        let binary_only = partition(vec![scan_file(&binary, plain())]).0;
        assert_eq!(
            exit_code(&binary_only, true),
            1,
            "a binary file never fails --strict"
        );
    }

    /// ripgrep's own test, and the reason it is that one: a NUL byte
    /// after the first 8 KiB belongs to a file this already read as
    /// text, and re-classifying it late would drop findings already
    /// reported above it.
    #[test]
    fn binary_is_a_nul_byte_in_the_first_8_kib() {
        let tree = TempTree::new("scan-sniff");
        let mut late = vec![b'1'; BINARY_SNIFF_BYTES + 16];
        late[BINARY_SNIFF_BYTES + 8] = 0;
        let file = tree.write_bytes("late.txt", &late);
        assert_ne!(scan_file(&file, plain()), Scanned::Binary);
    }

    #[test]
    fn the_format_comes_from_the_file_name() {
        let tree = TempTree::new("scan-format");
        let file = tree.write("config.toml", "ttl = \"30s\"\n");
        let report = read(&file, plain());
        assert_eq!(report.format, "toml");
        assert_eq!(values(&report), ["30s"]);
    }

    /// The case the fallback is for: nobody names a manifest's format,
    /// and it is full of quantities.
    #[test]
    fn an_unnamed_format_is_a_text_scan() {
        let tree = TempTree::new("scan-fallback");
        let file = tree.write("NOTES.md", "The cache holds 512MiB for 1h30m.\n");
        let report = read(&file, plain());
        assert_eq!(report.format, "unknown");
        assert_eq!(values(&report), ["512MiB", "1h30m"]);
    }

    #[test]
    fn a_forced_format_overrides_the_file_name() {
        let tree = TempTree::new("scan-forced");
        let file = tree.write("data.json", "ttl = \"30s\"\n");
        let report = read(
            &file,
            ScanOptions {
                format: Some("toml"),
                ..plain()
            },
        );
        assert_eq!(report.format, "toml");
        assert_eq!(values(&report), ["30s"]);
    }

    #[test]
    fn a_dimension_filter_reaches_the_report() {
        let report = scan_content(
            "a: 30s\nb: 1MiB",
            "a.yaml".into(),
            "yaml",
            ScanOptions {
                extract: Options {
                    dimension: Some(Dimension::Bytes),
                },
                ..plain()
            },
        );
        assert_eq!(values(&report), ["1MiB"]);
    }

    #[test]
    fn the_human_line_carries_the_position_the_text_and_the_base() {
        let report = scan_content(r#"{"ttl":"30s"}"#, "a.json".into(), "json", plain());
        assert_eq!(
            describe(&report, &report.quantities[0]),
            "a.json:1:9  30s  30000 milliseconds"
        );
    }

    /// Windows only, because on Unix there is nothing to rewrite: `\` is
    /// a legal character in a filename there, and replacing it would
    /// rename the file in the report.
    #[cfg(windows)]
    #[test]
    fn a_reported_path_is_separated_by_forward_slashes() {
        assert_eq!(
            report_path(Path::new(r"C:\config\cache.yaml")),
            "C:/config/cache.yaml"
        );
    }

    #[test]
    fn the_human_line_names_the_reason_when_there_is_no_base() {
        let report = scan_content("a: 500m", "a.yaml".into(), "yaml", plain());
        assert!(
            describe(&report, &report.quantities[0]).ends_with("500m  refused: ambiguous_unit"),
            "{}",
            describe(&report, &report.quantities[0])
        );
    }
}

#[cfg(test)]
mod hazards {
    use super::*;

    #[test]
    fn a_byte_order_mark_is_not_part_of_the_document() {
        assert_eq!(without_bom("\u{feff}abc"), "abc");
        assert_eq!(without_bom("abc"), "abc");
        // Only a leading one: elsewhere it is a zero-width no-break
        // space and belongs to the text.
        assert_eq!(without_bom("a\u{feff}b"), "a\u{feff}b");
    }
}
