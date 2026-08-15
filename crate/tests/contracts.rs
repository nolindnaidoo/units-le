//! The exit codes and the stdout contract, driven against the built
//! binary.
//!
//! These are the API: a shell branches on the exit code and parses
//! stdout, so both are pinned here rather than inferred from unit tests
//! of the functions behind them. Nothing here needs a network or a
//! privileged filesystem operation, so it runs everywhere on every push.
//!
//! A new refusal adds its case here.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

const BINARY: &str = env!("CARGO_BIN_EXE_units-le");
static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new(name: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "units-le-contract-{name}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a temporary directory");
        Self {
            root: std::fs::canonicalize(&root).expect("a canonical directory"),
        }
    }

    fn path(&self) -> &Path {
        &self.root
    }

    fn write(&self, relative: &str, contents: &str) -> PathBuf {
        self.write_bytes(relative, contents.as_bytes())
    }

    fn write_bytes(&self, relative: &str, contents: &[u8]) -> PathBuf {
        let target = self.root.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("a parent directory");
        }
        std::fs::write(&target, contents).expect("a file");
        target
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct Run {
    code: i32,
    stdout: String,
    stderr: String,
}

fn run(args: &[&str]) -> Run {
    let output = Command::new(BINARY)
        .args(args)
        .output()
        .expect("the binary runs");
    Run {
        code: output.status.code().expect("an exit code"),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

/// Every line of stdout, parsed. Doubles as the assertion that stdout
/// is JSON Lines and nothing else — a stray human message there would
/// fail to parse.
fn reports(run: &Run) -> Vec<serde_json::Value> {
    run.stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("stdout carries only JSON"))
        .collect()
}

/// A structured config, a dotenv, and prose — the three shapes a real
/// tree holds.
fn audit_tree(name: &str) -> Tree {
    let tree = Tree::new(name);
    tree.write("config.yaml", "timeout: 30s\nmemory: 512MiB\nport: 8080\n");
    tree.write("limits.env", "TTL=1h30m\nNAME=standard\n");
    tree.write("NOTES.md", "The sampler runs at 44.1kHz.\n");
    tree
}

#[test]
fn a_tree_with_quantities_exits_zero() {
    let tree = audit_tree("found");
    let run = run(&[&tree.path().to_string_lossy()]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    let total: u64 = reports(&run)
        .iter()
        .filter_map(|report| report["summary"]["quantities"].as_u64())
        .sum();
    assert_eq!(
        total, 4,
        "the timeout, the memory, the TTL and the sample rate — port 8080 has no unit"
    );
}

/// grep's convention, and the reason it is worth having: finding nothing
/// is an answer, not an error.
#[test]
fn a_tree_with_none_exits_one() {
    let tree = Tree::new("none");
    tree.write("docs/a.md", "no quantities in this prose at all\n");
    let run = run(&[&tree.path().to_string_lossy()]);
    assert_eq!(run.code, 1);
    assert!(run.stderr.contains("0 quantities"), "{}", run.stderr);
}

/// The whole contract in one report: the text the document holds, and
/// that value in one base unit.
#[test]
fn a_quantity_carries_its_text_and_its_base() {
    let tree = Tree::new("shape");
    tree.write("a.yaml", "memory: 512MiB\n");
    let report = reports(&run(&[&tree.path().to_string_lossy()])).remove(0);
    assert_eq!(report["schema"], 1);
    assert_eq!(report["format"], "yaml");
    let found = &report["quantities"][0];
    assert_eq!(found["value"], "512MiB");
    assert_eq!(found["base"], "536870912");
    assert_eq!(found["baseUnit"], "bytes");
    assert_eq!(found["dimension"], "bytes");
    assert_eq!(found["key"], "memory");
    assert_eq!(found["line"], 1);
    assert_eq!(found["column"], 9);
    assert_eq!(report["summary"]["quantities"], 1);
    assert_eq!(report["summary"]["refused"], 0);
}

/// Both are strings, and this is the case that says why: through a JSON
/// number a caller's parser rounds this to a different byte count.
#[test]
fn a_base_value_past_the_safe_integer_range_is_still_exact() {
    let tree = Tree::new("exact");
    tree.write("a.yaml", "disk: 9PiB\n");
    let report = reports(&run(&[&tree.path().to_string_lossy()])).remove(0);
    assert_eq!(report["quantities"][0]["base"], "10133099161583616");
    assert!(report["quantities"][0]["base"].is_string());
}

/// The boundary that keeps this tool and numbers-le distinct. A file of
/// bare numbers is not this tool's question, and it says so by finding
/// nothing rather than by failing.
#[test]
fn a_bare_number_is_not_a_finding() {
    let tree = Tree::new("bare");
    tree.write("a.json", "{\"port\":8080,\"rate\":0.0825}\n");
    let run = run(&[&tree.path().to_string_lossy()]);
    assert_eq!(run.code, 1, "{}", run.stderr);
    assert_eq!(reports(&run)[0]["summary"]["quantities"], 0);
}

/// **The design spine.** Each of these is a quantity this tool can see
/// and will not resolve, and each keeps its row, its text and its reason.
#[test]
fn every_refusal_is_a_row_with_a_named_reason() {
    let tree = Tree::new("refusals");
    tree.write(
        "a.yaml",
        "cpu: 500m\ndisk: 1.5KB\nlatency: 1,5s\ntotal: 1h + 30m\n",
    );
    let run = run(&[&tree.path().to_string_lossy()]);
    assert_eq!(run.code, 0, "a refusal is a finding, not a failure");

    let report = reports(&run).remove(0);
    assert_eq!(report["summary"]["quantities"], 4);
    assert_eq!(report["summary"]["refused"], 4);

    let rows: Vec<(&str, &str)> = report["quantities"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| {
            assert!(row["base"].is_null(), "{row}");
            assert!(row["detail"].is_string(), "a reason a person can act on");
            (
                row["value"].as_str().expect("a value"),
                row["reason"].as_str().expect("a reason"),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("500m", "ambiguous_unit"),
            ("1.5KB", "fractional_bytes"),
            ("1,5s", "locale_separator"),
            ("1h + 30m", "compound_arithmetic"),
        ]
    );
}

/// `1h30m` is a grammar and `1h + 30m` is arithmetic. The pair is here
/// because getting one of them wrong is the mistake this tool is for.
#[test]
fn a_compound_is_read_and_a_sum_is_refused() {
    let tree = Tree::new("compound");
    tree.write("a.yaml", "grammar: 1h30m\nsum: 1h + 30m\n");
    let report = reports(&run(&[&tree.path().to_string_lossy()])).remove(0);
    assert_eq!(report["quantities"][0]["base"], "5400000");
    assert!(report["quantities"][1]["base"].is_null());
    assert_eq!(report["quantities"][1]["reason"], "compound_arithmetic");
}

/// The one reason that keeps its base value. SI is what the symbol says;
/// the hazard is that the writer may have meant otherwise.
#[test]
fn an_si_byte_multiple_is_answered_and_flagged() {
    let tree = Tree::new("hazard");
    tree.write("a.yaml", "memory: 1MB\n");
    let run = run(&["--strict", &tree.path().to_string_lossy()]);
    assert_eq!(run.code, 0, "a hazard is not a refusal");
    let found = &reports(&run)[0]["quantities"][0];
    assert_eq!(found["base"], "1000000");
    assert_eq!(found["reason"], "si_iec_hazard");
    assert_eq!(reports(&run)[0]["summary"]["refused"], 0);
}

/// `--strict` is the pipeline's opt-in: every quantity resolved, or the
/// build stops.
#[test]
fn strict_turns_a_refusal_into_an_exit_two() {
    let tree = Tree::new("strict");
    tree.write("a.yaml", "cpu: 500m\n");
    assert_eq!(run(&[&tree.path().to_string_lossy()]).code, 0);
    let strict = run(&["--strict", &tree.path().to_string_lossy()]);
    assert_eq!(strict.code, 2);
    assert!(strict.stderr.contains("refused"), "{}", strict.stderr);
}

#[test]
fn a_dimension_filter_narrows_the_report() {
    let tree = Tree::new("dimension");
    tree.write("a.yaml", "ttl: 30s\nmemory: 512MiB\nshare: 15%\n");
    let run = run(&["--dimension", "bytes", &tree.path().to_string_lossy()]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    let report = reports(&run).remove(0);
    assert_eq!(report["summary"]["quantities"], 1);
    assert_eq!(report["quantities"][0]["value"], "512MiB");
}

/// A refusal that names no dimension survives every filter, because it
/// could have been the one asked for. Filtering it out would be the tool
/// deciding what it just said it could not decide.
#[test]
fn a_dimension_filter_never_hides_an_unidentified_refusal() {
    let tree = Tree::new("filter-refusal");
    tree.write("a.yaml", "cpu: 500m\nttl: 30s\n");
    for dimension in ["duration", "bytes", "percent", "frequency"] {
        let run = run(&["--dimension", dimension, &tree.path().to_string_lossy()]);
        let values: Vec<String> = reports(&run)[0]["quantities"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|row| row["value"].to_string())
            .collect();
        assert!(values.contains(&"\"500m\"".to_string()), "{dimension}");
    }
}

/// A format nobody recognises falls back to the text scan; a dimension
/// nobody recognises has nothing to fall back to.
#[test]
fn an_unknown_format_falls_back_and_an_unknown_dimension_does_not() {
    let tree = audit_tree("unknown");
    let format = run(&["--format", "klingon", &tree.path().to_string_lossy()]);
    assert_eq!(format.code, 0, "{}", format.stderr);
    assert!(
        reports(&format)
            .iter()
            .all(|report| report["format"] == "unknown")
    );

    let dimension = run(&["--dimension", "length", &tree.path().to_string_lossy()]);
    assert_eq!(dimension.code, 2);
    assert!(dimension.stderr.contains("length"), "{}", dimension.stderr);
    assert!(dimension.stdout.is_empty(), "a refusal writes no report");
}

/// The audit case: nobody names a manifest's format, and it is full of
/// quantities.
#[test]
fn prose_and_unnamed_formats_still_yield_their_quantities() {
    let tree = Tree::new("prose");
    tree.write(
        "deploy.tf",
        "  timeout = \"30s\"\n  # the cache holds 512MiB\n",
    );
    let report = reports(&run(&[&tree.path().to_string_lossy()])).remove(0);
    assert_eq!(report["format"], "unknown");
    assert_eq!(report["summary"]["quantities"], 2);
}

#[test]
fn a_binary_file_is_counted_and_a_broken_text_file_is_reported() {
    let tree = Tree::new("binary");
    tree.write("limits.env", "TTL=30s\n");
    tree.write_bytes("logo.png", &[0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]);

    let clean = run(&[&tree.path().to_string_lossy()]);
    assert_eq!(clean.code, 0, "{}", clean.stderr);
    let files: Vec<String> = reports(&clean)
        .iter()
        .filter_map(|report| report["file"].as_str())
        .map(|file| file.rsplit(['/', '\\']).next().unwrap_or(file).to_string())
        .collect();
    assert_eq!(files, ["limits.env"], "the PNG produced no report line");
    assert!(
        clean.stderr.contains("1 binary file skipped"),
        "the count is the reader's only sign coverage was narrower: {}",
        clean.stderr
    );

    // Text by name and by sniff — invalid UTF-8 with no NUL byte — so it
    // is still a named report and still fails --strict.
    tree.write_bytes("notes.txt", &[0x68, 0x69, 0xff, 0xfe]);
    let broken = run(&["--strict", &tree.path().to_string_lossy()]);
    assert_eq!(broken.code, 2, "{}", broken.stderr);
    assert!(
        broken.stderr.contains("not UTF-8 text"),
        "{}",
        broken.stderr
    );
}

#[test]
fn an_unreadable_input_exits_two() {
    assert_eq!(run(&["/no/such/place-xyz"]).code, 2);
}

/// A broken document is a fact about that file, not a failed run.
#[test]
fn a_broken_document_warns_without_failing_the_run() {
    let tree = Tree::new("broken");
    tree.write("bad.json", "{not json\n");
    tree.write("good.json", "{\"ttl\":\"30s\"}\n");
    let run = run(&[&tree.path().to_string_lossy()]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert!(
        run.stderr.contains("Failed to parse JSON"),
        "{}",
        run.stderr
    );
}

#[test]
fn an_unknown_flag_exits_two_and_names_itself() {
    let tree = audit_tree("badflag");
    let run = run(&["--dimensions", &tree.path().to_string_lossy()]);
    assert_eq!(run.code, 2);
    assert!(run.stderr.contains("--dimensions"), "{}", run.stderr);
    assert!(run.stdout.is_empty(), "a refusal writes no report");
}

/// This tool reports and normalises. It does not convert, rewrite, or
/// judge — and no flag asks it to.
#[test]
fn no_flag_asks_for_a_judgment() {
    let tree = audit_tree("nojudgment");
    for attempt in ["--convert", "--to", "--max", "--min", "--fix"] {
        assert_eq!(
            run(&[attempt, &tree.path().to_string_lossy()]).code,
            2,
            "{attempt} was accepted"
        );
    }
}

#[test]
fn version_and_help_exit_clear() {
    let version = run(&["--version"]);
    assert_eq!(version.code, 0);
    assert!(version.stdout.contains("units-le"));
    let help = run(&["--help"]);
    assert_eq!(help.code, 0);
    assert!(help.stdout.contains("usage: units-le"));
    assert!(
        help.stdout.contains("grep"),
        "the exit convention is stated"
    );
}

#[test]
fn stdout_carries_only_reports_and_stderr_only_the_summary() {
    let tree = audit_tree("streams");
    let run = run(&[&tree.path().to_string_lossy()]);
    assert!(!reports(&run).is_empty());
    assert!(!run.stderr.contains('{'), "{}", run.stderr);
    assert!(run.stderr.contains("quantities in"), "{}", run.stderr);
    assert!(
        run.stderr.contains("536870912 bytes"),
        "the human half carries the base value: {}",
        run.stderr
    );
}

#[test]
fn a_document_on_stdin_is_scanned() {
    let mut child = Command::new(BINARY)
        .args(["--stdin", "--format", "yaml"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the binary runs");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(b"ttl: 30s")
        .expect("written");
    let output = child.wait_with_output().expect("finishes");
    assert_eq!(output.status.code(), Some(0));
    let report: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout carries JSON");
    assert_eq!(report["file"], "<stdin>");
    assert_eq!(report["quantities"][0]["base"], "30000");
}

/// **The cross-surface contract.** Both surfaces call one entry point,
/// so they must answer identically for the same tree.
#[test]
fn the_cli_and_the_mcp_server_report_the_same_thing() {
    let tree = audit_tree("agreement");
    let cli = run(&[&tree.path().to_string_lossy()]);
    let from_cli = reports(&cli);

    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "units_le_scan",
            "arguments": { "path": tree.path().to_string_lossy() },
        },
    });
    let mut child = Command::new(BINARY)
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the server starts");
    writeln!(child.stdin.as_mut().expect("stdin"), "{request}").expect("written");
    let output = child.wait_with_output().expect("finishes");
    let response: serde_json::Value = serde_json::from_slice(
        output
            .stdout
            .split(|byte| *byte == b'\n')
            .next()
            .expect("a line"),
    )
    .expect("the reply is JSON");

    let from_mcp = response["result"]["structuredContent"]["data"]["reports"]
        .as_array()
        .expect("reports")
        .clone();
    assert_eq!(from_mcp, from_cli, "the two surfaces disagree");
}

/// Every value in a document, whatever it is called.
fn values(run: &Run) -> Vec<String> {
    reports(run)
        .iter()
        .flat_map(|report| {
            report["quantities"]
                .as_array()
                .expect("quantities")
                .iter()
                .map(|q| q["value"].as_str().expect("a value").to_string())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// **Naming a format may never find less than not naming one.**
///
/// This is the audit's own differential, kept as a gate. Each of these
/// shipped: `.conf` and `.cfg` named the INI reader, which accepts
/// free-form text as a valid document holding no values; `.tsv` named
/// the comma reader, which made a whole tab row one cell. Both returned
/// no quantities, an empty `diagnostics` and exit 1 — a file that reads
/// to whoever ran it as a file that was clean, which SPEC.md calls the
/// one outcome never allowed.
///
/// The property is deliberately wider than those three cases: any
/// extension that resolves to a reader must find at least what the same
/// bytes find with no extension at all, or say on `diagnostics` why it
/// could not.
#[test]
fn a_named_format_never_finds_less_than_the_text_scan() {
    let tree = Tree::new("named-vs-scan");
    for (name, body) in [
        (
            "nginx.conf",
            "http {\n  client_max_body_size 512MiB;\n  keepalive_timeout 30s;\n}\n",
        ),
        ("app.cfg", "port 8080\ntimeout 30s\nmaxmemory 512MiB\n"),
        ("limits.tsv", "name\tttl\tmemory\napi\t30s\t512MiB\n"),
        (
            "settings.jsonc",
            "{\n  // the request budget\n  \"timeout\": \"30s\",\n}\n",
        ),
    ] {
        let named = tree.write(name, body);
        let bare = tree.write(&format!("{name}.unknown-to-this-tool"), body);

        let named_run = run(&[&named.to_string_lossy()]);
        let bare_run = run(&[&bare.to_string_lossy()]);

        let mut found = values(&named_run);
        let mut baseline = values(&bare_run);
        found.sort();
        baseline.sort();

        let diagnosed = !reports(&named_run)[0]["diagnostics"]
            .as_array()
            .expect("diagnostics")
            .is_empty();

        assert!(
            found == baseline || diagnosed,
            "{name} found {found:?} where the text scan found {baseline:?}, \
             and said nothing about the difference"
        );
    }
}

/// The two readers that changed, at the level a user meets them.
#[test]
fn a_tab_separated_file_and_a_commented_json_file_are_read() {
    let tree = Tree::new("tsv-jsonc");
    let tsv = tree.write("limits.tsv", "name\tttl\napi\t30s\n");
    let jsonc = tree.write(
        "s.jsonc",
        "{\n  // a comment, which is the point\n  \"t\": \"1h\",\n}\n",
    );

    let tsv_run = run(&[&tsv.to_string_lossy()]);
    assert_eq!(tsv_run.code, 0, "{}", tsv_run.stderr);
    assert_eq!(values(&tsv_run), ["30s"]);
    assert_eq!(reports(&tsv_run)[0]["format"], "tsv");

    let jsonc_run = run(&[&jsonc.to_string_lossy()]);
    assert_eq!(jsonc_run.code, 0, "{}", jsonc_run.stderr);
    assert_eq!(values(&jsonc_run), ["1h"]);
    assert_eq!(reports(&jsonc_run)[0]["format"], "jsonc");
}
