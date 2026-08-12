//! The terminal surface.
//!
//! stdout is always protocol — one JSON report per line, one line per
//! file. stderr is always for the human, and is a projection of the same
//! reports rather than parallel prose.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use crate::extract::{Dimension, Options, resolve_format};
use crate::scan::{self, FileReport, ScanOptions};
use crate::walk::{self, WalkOptions};

const USAGE: &str = "usage: units-le [options] <file|dir>...
       units-le [options] --stdin [--format <format>]
       units-le mcp
       units-le --version | --help

Finds every quantity in a tree — a number welded to a unit — and reports
it twice: the text the document actually holds, and that value in one
base unit so two of them can be compared. JSON, YAML, CSV, TOML, INI and
dotenv are parsed; anything else is scanned as text, so a Kubernetes
manifest or a Markdown table of limits yields its quantities rather than
nothing.

Four dimensions: duration (milliseconds), bytes (bytes), percent (a
ratio), frequency (hertz).

What it will not do is guess. A bare `m`, a fractional `1.5KB`, a
locale-shaped `1,5s` and an expression like `1h + 30m` are each reported
with a named reason and no base value. A refusal is a finding, never a
dropped row.

A bare number with no unit is not a finding at all — that is numbers-le's
question.

Options:
  --dimension <name>   report only duration, bytes, percent or frequency.
                       A refusal that names no dimension is always kept:
                       it could have been the one you asked for
  --format <format>    force a format instead of inferring it from the
                       file name; an unknown name falls back to the text
                       scan rather than failing
  --strict             exit 2 if any quantity was refused, or any text
                       file could not be read
  --stdin              read one document from stdin
  --hidden             walk hidden files and directories too
  --no-ignore          walk files that .gitignore excludes

A binary file — a NUL byte in its first 8 KiB, ripgrep's own test — is
never a text candidate: it produces no report line, is counted on stderr,
and never fails the run.

Exit codes follow grep: 0 quantities found · 1 none found · 2 malformed
question. Finding none is an answer, not an error.";

/// Every flag the parser accepts. Held equal to the flags named in
/// USAGE by a test, and consulted at runtime so the list is what the
/// parser actually honours.
const FLAGS: [&str; 6] = [
    "--dimension",
    "--format",
    "--strict",
    "--stdin",
    "--hidden",
    "--no-ignore",
];

#[derive(Debug)]
struct Cli {
    /// Fail the run on a refusal or an unreadable text file.
    strict: bool,
    inputs: Vec<PathBuf>,
    stdin: bool,
    scan: ScanOptions,
    walk: WalkOptions,
}

pub(crate) fn run() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if let Some(first) = args.first() {
        match first.as_str() {
            "mcp" => return crate::mcp::serve(),
            "--help" | "-h" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            "--version" | "-V" => {
                println!("units-le {}", env!("CARGO_PKG_VERSION"));
                return ExitCode::SUCCESS;
            }
            _ => {}
        }
    }

    match execute(&args) {
        Ok(code) => ExitCode::from(code),
        Err(message) => {
            eprintln!("units-le: {message}");
            ExitCode::from(2)
        }
    }
}

fn execute(args: &[String]) -> Result<u8, String> {
    let options = parse(args)?;
    let (reports, binary) = if options.stdin {
        (vec![scan_stdin(&options)?], 0)
    } else {
        let scanned = walk::collect(&options.inputs, &options.walk)?
            .iter()
            .map(|target| scan::scan_file(target, options.scan))
            .collect();
        scan::partition(scanned)
    };

    write_reports(&reports)?;
    summarise(&reports, binary);
    Ok(scan::exit_code(&reports, options.strict))
}

fn write_reports(reports: &[FileReport]) -> Result<(), String> {
    let mut stdout = std::io::stdout().lock();
    for report in reports {
        // A report is plain data — strings, integers and unit-variant
        // enums, every map keyed by a string and no float anywhere — so
        // there is no input on which `to_string` can fail. The write is
        // the fallible half, and it is carried to the caller.
        let line = serde_json::to_string(report).expect("a report serializes");
        writeln!(stdout, "{line}")
            .map_err(|error| format!("could not write the report: {error}"))?;
    }
    Ok(())
}

fn scan_stdin(options: &Cli) -> Result<FileReport, String> {
    let mut content = String::new();
    std::io::stdin()
        .read_to_string(&mut content)
        .map_err(|error| format!("could not read stdin: {error}"))?;
    // No filename to infer from, so an unnamed format falls back — which
    // is the text scan, and needs no special case.
    let format = options
        .scan
        .format
        .unwrap_or(crate::extract::FALLBACK_FORMAT);
    Ok(scan::scan_content(
        &content,
        "<stdin>".to_string(),
        format,
        options.scan,
    ))
}

fn parse(args: &[String]) -> Result<Cli, String> {
    let mut options = Cli {
        inputs: Vec::new(),
        stdin: false,
        strict: false,
        scan: ScanOptions::default(),
        walk: WalkOptions::default(),
    };

    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        // Strict parsing, never a silent default: a typo'd `--strick`
        // that quietly did nothing would report a clean audit that never
        // ran the check asked for.
        if arg.starts_with('-') && !FLAGS.contains(&arg.as_str()) {
            return Err(format!("{arg} is not an option. Try --help."));
        }

        match arg.as_str() {
            "--stdin" => options.stdin = true,
            "--strict" => options.strict = true,
            "--hidden" => options.walk.hidden = true,
            "--no-ignore" => options.walk.respect_ignore = false,
            // An unknown format falls back rather than failing, which is
            // what lets this be pointed at a repository nobody has
            // described to it. The flag still takes a value, so a
            // missing one is a refusal.
            "--format" => {
                let value = rest
                    .next()
                    .ok_or_else(|| "--format needs a format".to_string())?;
                options.scan.format = Some(resolve_format(Some(value), None));
            }
            // **A dimension does not fall back.** A format nobody
            // recognises still has an answer — scan the text — but a
            // dimension nobody recognises has none, and quietly
            // reporting all four would answer a question that was not
            // asked.
            "--dimension" => {
                let value = rest
                    .next()
                    .ok_or_else(|| "--dimension needs a name".to_string())?;
                options.scan.extract = Options {
                    dimension: Some(Dimension::named(&value.to_lowercase()).ok_or_else(|| {
                        format!(
                            "{value} is not a dimension. Try duration, bytes, percent or frequency."
                        )
                    })?),
                };
            }
            path => options.inputs.push(PathBuf::from(path)),
        }
    }

    if options.stdin && !options.inputs.is_empty() {
        return Err("reading from stdin takes no file arguments".to_string());
    }
    if !options.stdin && options.inputs.is_empty() {
        return Err("name a file or a directory to read. Try --help.".to_string());
    }
    Ok(options)
}

/// The human half. Every line restates something already on stdout —
/// except the binary count, which is the one thing stdout cannot carry
/// because those files produce no report line at all.
fn summarise(reports: &[FileReport], binary: usize) {
    let quantities: usize = reports.iter().map(|report| report.summary.quantities).sum();
    let refused: usize = reports.iter().map(|report| report.summary.refused).sum();

    // Every write below is deliberately unchecked. stderr is the human
    // half, and a reader who closed it — `| head`, a pipeline that
    // stopped listening — has not made the audit fail: the answer is on
    // stdout, which is written first and whose failure is carried.
    let mut stderr = std::io::stderr().lock();
    for report in reports {
        for diagnostic in &report.diagnostics {
            let _ = writeln!(stderr, "{}: {}", report.file, diagnostic.message);
        }
        for found in &report.quantities {
            let _ = writeln!(stderr, "{}", scan::describe(report, found));
        }
    }

    let _ = writeln!(
        stderr,
        "{} in {}",
        plural(quantities, "quantity", "quantities"),
        plural(reports.len(), "file", "files")
    );
    if binary > 0 {
        // Not a report line, but not a silence either: a reader has to
        // know the scan covered fewer files than the tree holds.
        let _ = writeln!(
            stderr,
            "{} skipped",
            plural(binary, "binary file", "binary files")
        );
    }
    if refused > 0 {
        // The count that says how much of this report is an answer and
        // how much is a question.
        let _ = writeln!(
            stderr,
            "{} refused, each with a reason",
            plural(refused, "quantity", "quantities")
        );
    }
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::SUPPORTED_FORMATS;

    #[test]
    fn every_documented_flag_is_parsed_and_the_reverse() {
        let mut documented: Vec<&str> = USAGE
            .split_whitespace()
            .filter(|word| word.starts_with("--"))
            .map(|word| word.trim_end_matches([',', '.', ':', ';']))
            .filter(|word| !matches!(*word, "--version" | "--help"))
            .collect();
        documented.sort_unstable();
        documented.dedup();

        let mut implemented = FLAGS.to_vec();
        implemented.sort_unstable();
        assert_eq!(documented, implemented);
    }

    #[test]
    fn the_parser_accepts_every_flag_it_lists() {
        for flag in FLAGS {
            let args: Vec<String> = match flag {
                "--format" => vec![flag.into(), "json".into(), "x".into()],
                "--dimension" => vec![flag.into(), "bytes".into(), "x".into()],
                "--stdin" => vec![flag.into()],
                _ => vec![flag.into(), "x".into()],
            };
            assert!(parse(&args).is_ok(), "{flag}");
        }
    }

    #[test]
    fn an_unknown_flag_is_refused_rather_than_ignored() {
        let error = parse(&["--dimensions".into(), "x".into()]).expect_err("a refusal");
        assert!(error.contains("--dimensions"), "{error}");
    }

    /// The one place this crate is deliberately lenient: a format
    /// nobody recognises is the text scan, not a refusal.
    #[test]
    fn an_unknown_format_falls_back_rather_than_being_refused() {
        let options =
            parse(&["--format".into(), "handwriting".into(), "x".into()]).expect("accepted");
        assert_eq!(options.scan.format, Some(crate::extract::FALLBACK_FORMAT));
    }

    /// And the place it is not. A dimension nobody recognises has no
    /// answer to fall back to.
    #[test]
    fn an_unknown_dimension_is_refused_and_names_the_four() {
        let error =
            parse(&["--dimension".into(), "length".into(), "x".into()]).expect_err("a refusal");
        assert!(error.contains("length"), "{error}");
        for dimension in Dimension::ALL {
            assert!(error.contains(dimension.name()), "{error}");
        }
    }

    #[test]
    fn every_dimension_is_accepted_by_name_in_any_case() {
        for dimension in Dimension::ALL {
            let options = parse(&[
                "--dimension".into(),
                dimension.name().to_uppercase(),
                "x".into(),
            ])
            .expect("accepted");
            assert_eq!(options.scan.extract.dimension, Some(dimension));
        }
    }

    #[test]
    fn every_offered_format_is_accepted_by_name() {
        for format in SUPPORTED_FORMATS {
            let options = parse(&["--format".into(), format.into(), "x".into()]).expect(format);
            assert_eq!(options.scan.format, Some(format));
        }
    }

    #[test]
    fn a_flag_with_no_value_is_refused() {
        assert!(parse(&["--format".into()]).is_err());
        assert!(parse(&["--dimension".into()]).is_err());
    }

    /// This tool reports what a document says and normalises it. It does
    /// not convert, rewrite, or decide that a limit is too low — and
    /// there is no flag that would.
    #[test]
    fn no_flag_asks_for_a_judgment() {
        for attempt in ["--convert", "--to", "--max", "--min", "--fix", "--round"] {
            assert!(
                parse(&[attempt.into(), "x".into()]).is_err(),
                "{attempt} was accepted"
            );
        }
        for word in ["convert", "rewrite", "recommend", "too large"] {
            assert!(!USAGE.contains(word), "the usage text offers {word}");
        }
    }

    #[test]
    fn naming_nothing_is_refused() {
        assert!(parse(&[]).is_err());
    }

    #[test]
    fn stdin_and_file_arguments_together_are_refused() {
        assert!(parse(&["--stdin".into(), "x".into()]).is_err());
    }

    #[test]
    fn the_usage_text_states_greps_convention_and_the_refusal_rule() {
        assert!(USAGE.contains("grep"));
        for code in ["0", "1", "2"] {
            assert!(USAGE.contains(code), "exit code {code} is undocumented");
        }
        assert!(USAGE.contains("A refusal is a finding"));
    }
}
