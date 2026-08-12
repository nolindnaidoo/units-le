//! Behaviour that differs by operating system, asserted rather than
//! hoped.
//!
//! Every one of these is a thing that shipped wrong somewhere in this
//! family: a report full of `\` on Windows for a whole release, a suite
//! that depended on `TZ` and passed only where the variable is honoured,
//! a stdin test that raced the refusal it was asserting.
//!
//! Runs on macOS, Windows and Linux. Where a platform cannot express a
//! case it is skipped **by name** on stderr, never passed quietly.
//!
//! The CI job runs the whole suite twice — `TZ=UTC` and with `TZ`
//! removed — and diffs the test names and outcomes line for line.
//! Windows ignores the variable entirely, so a suite that quietly
//! depended on it would be red there and nowhere else;
//! `the_answer_does_not_depend_on_the_time_zone` below is the case that
//! names what identical means.

use std::fmt::Write as _;
use std::fs::File;
use std::io::Write as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

const BINARY: &str = env!("CARGO_BIN_EXE_units-le");
static COUNTER: AtomicUsize = AtomicUsize::new(0);
const LIMIT: Duration = Duration::from_secs(60);

struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new(name: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "units-le-platform-{name}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a temporary directory");
        Self {
            root: std::fs::canonicalize(&root).expect("a canonical directory"),
        }
    }

    fn text(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    fn write(&self, relative: &str, contents: &str) -> PathBuf {
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
    code: Option<i32>,
    stdout: String,
}

/// Run the binary with the environment named, bounded in time, with
/// output captured to a file rather than a pipe — a report longer than a
/// pipe buffer would otherwise deadlock the parent.
fn execute(args: &[&str], timezone: Option<&str>) -> Run {
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    let capture = std::env::temp_dir().join(format!(
        "units-le-platform-capture-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&capture).expect("a capture directory");
    let out = capture.join("stdout");

    let mut command = Command::new(BINARY);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(File::create(&out).expect("a stdout file"))
        .stderr(Stdio::null());
    match timezone {
        Some(zone) => command.env("TZ", zone),
        None => command.env_remove("TZ"),
    };

    let mut child = command.spawn().expect("the binary runs");
    let started = Instant::now();
    let status = loop {
        match child.try_wait().expect("the child can be waited on") {
            Some(status) => break status,
            None if started.elapsed() >= LIMIT => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("the run hung past {LIMIT:?}: {args:?}");
            }
            None => std::thread::sleep(Duration::from_millis(5)),
        }
    };

    let stdout = String::from_utf8_lossy(&std::fs::read(&out).unwrap_or_default()).into_owned();
    let _ = std::fs::remove_dir_all(&capture);
    Run {
        code: status.code(),
        stdout,
    }
}

fn run(args: &[&str]) -> Run {
    execute(args, Some("UTC"))
}

fn reports(run: &Run) -> Vec<serde_json::Value> {
    run.stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("stdout carries only JSON"))
        .collect()
}

fn basename(report: &serde_json::Value) -> String {
    let file = report["file"].as_str().unwrap_or_default();
    file.rsplit(['/', '\\']).next().unwrap_or(file).to_string()
}

fn skipped(case: &str, why: &str) {
    eprintln!("SKIPPED {case}: {why}");
}

/// A tree with nested directories, so a separator has somewhere to show
/// up.
fn nested(name: &str) -> Tree {
    let tree = Tree::new(name);
    tree.write("limits.env", "TTL=30s\n");
    tree.write("config/deep/cache.yaml", "ttl: 1h30m\nmemory: 512MiB\n");
    tree.write("docs/NOTES.md", "The sampler runs at 44.1kHz.\n");
    tree
}

/// **Every path in the report uses `/`, on every platform.** envsync-le
/// shipped `\` on Windows for a release, which made every path in a
/// Windows report differ from the same path in a Linux one for no reason
/// a reader could see — and a report is diffed against one produced
/// somewhere else, which is most of what a report in CI is for.
///
/// On Unix this passes by construction. The Windows leg is the check,
/// which is why the job runs on all three.
#[test]
fn every_path_in_the_report_is_separated_by_forward_slashes() {
    let tree = nested("separators");
    let outcome = run(&[&tree.text()]);
    assert_eq!(outcome.code, Some(0));
    let scanned = reports(&outcome);
    assert_eq!(scanned.len(), 3, "the whole tree was walked");
    for report in &scanned {
        let file = report["file"].as_str().expect("a file name");
        assert!(
            !file.contains('\\'),
            "a backslash in a reported path: {file}"
        );
        assert!(
            file.contains('/'),
            "a nested path lost its separators: {file}"
        );
    }
}

/// The human half is a projection of the same reports, so it carries the
/// same paths and must not grow its own spelling of them.
#[test]
fn the_human_summary_uses_the_same_separator_as_the_report() {
    let tree = nested("separators-human");
    let output = Command::new(BINARY)
        .arg(tree.text())
        .output()
        .expect("the binary runs");
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stderr.lines().filter(|line| line.contains("milliseconds")) {
        assert!(
            !line.contains('\\'),
            "a backslash on the human half: {line}"
        );
    }
}

/// **`TZ` independence.** This tool reads no clock at all, and that is
/// asserted rather than assumed — Windows ignores the variable, so a
/// suite that depended on it would pass on two platforms and fail on the
/// third, or worse pass everywhere and measure nothing.
#[test]
fn the_answer_does_not_depend_on_the_time_zone() {
    let tree = nested("timezone");
    let utc = execute(&[&tree.text()], Some("UTC"));
    let unset = execute(&[&tree.text()], None);
    let far = execute(&[&tree.text()], Some("Pacific/Kiritimati"));
    assert_eq!(utc.stdout, unset.stdout, "TZ=UTC differs from TZ unset");
    assert_eq!(utc.stdout, far.stdout, "the answer moved with the clock");
    assert_eq!(utc.code, unset.code);
    assert_eq!(utc.code, far.code);
}

/// **Case-folding filesystems.** `Limits.env` and `limits.env` are one
/// file on macOS and Windows and two on Linux. Either answer is correct;
/// reporting one file twice is not, and neither is a walk that
/// disagrees with the filesystem about how many there are.
#[test]
fn a_file_is_never_reported_twice_on_a_case_folding_filesystem() {
    let tree = Tree::new("case-fold");
    tree.write("Limits.env", "TTL=30s\n");
    tree.write("limits.env", "TTL=1h\n");

    let outcome = run(&[&tree.text()]);
    assert_eq!(outcome.code, Some(0));
    let named: Vec<String> = reports(&outcome)
        .iter()
        .filter_map(|report| report["file"].as_str())
        .map(str::to_string)
        .collect();

    if named.len() == 1 {
        eprintln!("case-folding filesystem: the two names are one file");
    }
    let mut unique = named.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(
        unique.len(),
        named.len(),
        "a file was reported twice: {named:?}"
    );
    assert!(
        named.len() <= 2,
        "more report lines than files written: {named:?}"
    );
}

/// **Reserved Windows filenames.** `CON`, `PRN`, `AUX`, `NUL` and `COM1`
/// are device names there and ordinary files everywhere else. The
/// assertion is that the walk survives whatever the filesystem allowed —
/// **not** that the files exist, which is the mistake that makes a test
/// red on one platform and vacuous on the others.
#[test]
fn the_walk_survives_the_reserved_windows_filenames() {
    let tree = Tree::new("reserved");
    tree.write("ordinary.env", "TTL=30s\n");

    let mut made = Vec::new();
    for reserved in ["CON", "PRN", "AUX", "NUL", "COM1"] {
        match std::fs::write(tree.root.join(reserved), "TTL=1h\n") {
            Ok(()) => made.push(reserved),
            Err(_) => skipped(
                &format!("a file named {reserved}"),
                "this filesystem reserves the name",
            ),
        }
    }

    let outcome = run(&[&tree.text()]);
    let code = outcome.code.expect("an exit code, not a signal");
    assert!((0..=2).contains(&code), "exit {code}");
    let named: Vec<String> = reports(&outcome).iter().map(basename).collect();
    assert!(
        named.iter().any(|file| file == "ordinary.env"),
        "the reserved names took the rest of the tree with them: \
         {named:?}, created: {made:?}"
    );
}

/// **CRLF changes nothing about what a document says.** A Windows
/// checkout with `core.autocrlf` hands every one of these formats an
/// extra `\r` before each newline, and a reader that let it into a value
/// would turn `30s\r` into a token this grammar does not know — a
/// quantity that silently stops being found on one platform.
///
/// Asserted per format as equality with the LF file, positions included,
/// rather than as "quantities were found".
#[test]
fn crlf_line_endings_do_not_change_what_a_document_says() {
    let tree = Tree::new("crlf");
    let documents = [
        ("limits.env", "TTL=30s\nMEM=512MiB\n"),
        ("cache.yaml", "ttl: 30s\nmem: 512MiB\n"),
        ("cache.toml", "ttl = \"30s\"\nmem = \"512MiB\"\n"),
        ("cache.ini", "[cache]\nttl = 30s\nmem = 512MiB\n"),
        ("export.csv", "30s,512MiB\n1h,2GB\n"),
        ("NOTES.md", "holds 30s and 512MiB\nand 1h more\n"),
    ];

    for (name, body) in documents {
        let unix = tree.write(&format!("lf/{name}"), body);
        let windows = tree.write(&format!("crlf/{name}"), &body.replace('\n', "\r\n"));

        let quantities = |path: &PathBuf| -> serde_json::Value {
            let outcome = run(&[&path.to_string_lossy()]);
            assert_eq!(outcome.code, Some(0), "{name}");
            reports(&outcome)[0]["quantities"].clone()
        };
        let expected = quantities(&unix);
        assert!(
            !expected.as_array().expect("rows").is_empty(),
            "{name}: the control case found nothing"
        );
        assert_eq!(
            quantities(&windows),
            expected,
            "{name}: a carriage return changed the answer"
        );
    }
}

/// A document arriving on stdin is read whole, on every platform —
/// including the one where a pipe is not a file descriptor. Ten thousand
/// rows so it arrives in pieces rather than in one buffer.
#[test]
fn a_document_on_stdin_is_read_whole() {
    let mut child = Command::new(BINARY)
        .args(["--stdin", "--format", "csv"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the binary runs");

    let mut document = String::new();
    for row in 0..10_000 {
        let _ = writeln!(document, "{}s,{}MiB", row % 97, row % 89);
    }
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(document.as_bytes())
        .expect("the child is still reading");
    drop(child.stdin.take());

    let output = child.wait_with_output().expect("the child finishes");
    assert_eq!(output.status.code(), Some(0));
    let report: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout carries JSON");
    assert_eq!(report["file"], "<stdin>");
    assert_eq!(
        report["summary"]["quantities"], 20_000,
        "a document arriving in pieces was read short"
    );
}

/// **Assert the exit code, never the write.** The child refuses its
/// arguments and exits before reading a byte, so the write races the
/// refusal — on a good day it succeeds, on a bad one it is a broken
/// pipe. That race cost a red CI once, on one platform, for reasons
/// that had nothing to do with the code.
#[test]
fn a_child_that_refuses_before_reading_stdin_still_exits_two() {
    let mut child = Command::new(BINARY)
        // --stdin takes no file arguments: refused by the parser, before
        // anything reads a byte.
        .args(["--stdin", "unexpected.yaml"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the binary runs");

    // Deliberately unchecked: a broken pipe here means the child refused
    // faster than this loop wrote, which is the behaviour under test.
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(&vec![b'x'; 1 << 20]);
        let _ = stdin.flush();
    }
    drop(child.stdin.take());

    let output = child.wait_with_output().expect("the child finishes");
    assert_eq!(
        output.status.code(),
        Some(2),
        "a malformed question is exit 2 whatever happened to stdin"
    );
    assert!(output.stdout.is_empty(), "a refusal wrote a report");
}

/// The MCP server reads stdin to end of stream. A client that goes away
/// before saying anything is a clean exit, not a hang and not a failure.
#[test]
fn the_mcp_server_exits_cleanly_when_stdin_closes_immediately() {
    let mut child = Command::new(BINARY)
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the binary runs");
    drop(child.stdin.take());

    let output = child.wait_with_output().expect("the child finishes");
    assert_eq!(
        output.status.code(),
        Some(0),
        "stdout was {:?}",
        String::from_utf8_lossy(&output.stdout)
    );
}

/// A path the caller typed comes back the way the caller typed it. A
/// refusal that helpfully rewrites separators cannot be grepped for, and
/// on Windows it is the step that makes a message machine-specific.
#[test]
fn a_refusal_names_the_path_the_caller_gave_it() {
    let tree = Tree::new("refusal-path");
    let missing = tree.root.join("nested").join("gone.yaml");
    let given = missing.to_string_lossy().into_owned();

    let output = Command::new(BINARY)
        .arg(&given)
        .output()
        .expect("the binary runs");
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(&given),
        "the refusal rewrote the path it was given\n  given: {given}\n  said:  {stderr}"
    );
    assert!(output.stdout.is_empty(), "a refusal wrote a report");
}

/// A directory named as though it were a document. The walk descends
/// into it rather than trying to read it, on every platform.
#[test]
fn a_directory_wearing_a_documents_extension_is_walked_into() {
    let tree = Tree::new("dir-extension");
    tree.write("cache.yaml/inner.env", "TTL=30s\n");

    let outcome = run(&[&tree.text()]);
    assert_eq!(outcome.code, Some(0), "the directory was read as a file");
    let named: Vec<String> = reports(&outcome).iter().map(basename).collect();
    assert_eq!(named, ["inner.env"]);
}
