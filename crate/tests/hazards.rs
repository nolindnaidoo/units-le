//! Inputs a real machine holds and a fixture directory cannot.
//!
//! **Not a fixture directory.** Windows cannot check in a FIFO, a
//! symlink loop, a mode-000 file or a path over 260 characters, so the
//! tree is built at runtime and every case a platform cannot express
//! says so **by name** on stderr rather than passing quietly. A skip is
//! never a pass.
//!
//! Every case asserts the same floor: the process does not panic, does
//! not hang, and exits 0, 1 or 2 — never on a signal. On top of that
//! each one names the defect it exists for, and three of them shipped
//! somewhere in this family: a byte-order mark read as content emptied
//! three crates silently, a PNG made `--strict` exit 2 on every
//! repository holding an image, and a non-UTF-8 file vanished from the
//! report entirely — which reads to whoever ran it as a file that was
//! clean.

use std::fmt::Write as _;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

const BINARY: &str = env!("CARGO_BIN_EXE_units-le");
static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Generous enough that a loaded shared runner reading a multi-megabyte
/// line does not flake, tight enough that a blocking read on a FIFO is a
/// failure rather than a job timeout with no message.
const LIMIT: Duration = Duration::from_secs(60);

/// A quantity every content hazard carries, so "the file was read" has
/// an answer rather than an absence.
const QUANTITY: &str = "30s";

struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new(name: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "units-le-hazard-{name}-{}-{unique}",
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

    fn text(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    fn write(&self, relative: &str, contents: &str) -> PathBuf {
        self.write_bytes(relative, contents.as_bytes())
    }

    /// Bytes rather than text, for the files that are the point: a
    /// UTF-16 document, a lone invalid sequence, a byte-order mark.
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
    /// `None` when the process died on a signal, which is the failure
    /// this whole file is watching for.
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Run the binary, bounded in time, with both streams captured to files.
///
/// Files rather than pipes on purpose: a report for a document of a
/// hundred thousand quantities fills a pipe buffer, and a parent that
/// waits before draining one deadlocks — which looks exactly like the
/// hang this is here to detect.
fn execute(args: &[&str]) -> Run {
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    let capture = std::env::temp_dir().join(format!(
        "units-le-hazard-capture-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&capture).expect("a capture directory");
    let out = capture.join("stdout");
    let err = capture.join("stderr");

    let mut child = Command::new(BINARY)
        .args(args)
        // Never inherit the terminal: `--stdin` reads it, and a child
        // waiting on a keyboard that is not there is a hang with an
        // innocent explanation.
        .stdin(Stdio::null())
        .stdout(File::create(&out).expect("a stdout file"))
        .stderr(File::create(&err).expect("a stderr file"))
        .spawn()
        .expect("the binary runs");

    let started = Instant::now();
    let status = loop {
        match child.try_wait().expect("the child can be waited on") {
            Some(status) => break status,
            None if started.elapsed() >= LIMIT => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_dir_all(&capture);
                panic!("the run hung past {LIMIT:?}: {args:?}");
            }
            None => std::thread::sleep(Duration::from_millis(5)),
        }
    };

    let read = |path: &Path| {
        String::from_utf8_lossy(&std::fs::read(path).unwrap_or_default()).into_owned()
    };
    let run = Run {
        code: status.code(),
        stdout: read(&out),
        stderr: read(&err),
    };
    let _ = std::fs::remove_dir_all(&capture);
    run
}

/// The floor every case shares. A signal — `code()` of `None` on Unix —
/// is the abort class this net exists to catch.
fn assert_answered(run: &Run, case: &str) {
    let code = run
        .code
        .unwrap_or_else(|| panic!("{case}: the process died on a signal, not an exit code"));
    assert!(
        (0..=2).contains(&code),
        "{case}: exit {code} is not one of grep's three\n{}",
        run.stderr
    );
}

/// Every line of stdout, parsed. Doubles as the assertion that stdout is
/// JSON Lines and nothing else — a stray human message there would fail
/// to parse.
fn reports(run: &Run) -> Vec<serde_json::Value> {
    run.stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("stdout carries only JSON"))
        .collect()
}

/// The report for one file, by the name it ends with.
fn report_for<'a>(scanned: &'a [serde_json::Value], name: &str) -> Option<&'a serde_json::Value> {
    scanned.iter().find(|report| {
        report["file"]
            .as_str()
            .is_some_and(|file| file.ends_with(name))
    })
}

/// A case the platform cannot express. Named on stderr so a green run
/// still says what it did not check — a silent skip is a lie.
fn skipped(case: &str, why: &str) {
    eprintln!("SKIPPED {case}: {why}");
}

fn utf16le_with_bom(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xff, 0xfe];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

// ---------------------------------------------------------------- content

/// **The defect that silently emptied three crates in this family.**
/// Three invisible bytes Notepad, Excel and a PowerShell redirect all
/// add. Read as content they shift every column on the first line, and
/// in a structured format they lose the whole document — which is
/// indistinguishable from a file with no quantities in it.
///
/// Asserted as equality with the unmarked file rather than as "a
/// quantity was found": a BOM that moved the column by three would pass
/// the weaker check.
#[test]
fn a_byte_order_mark_neither_empties_a_document_nor_moves_a_column() {
    let tree = Tree::new("bom");
    let body = format!("ttl: {QUANTITY}\nmemory: 512MiB\n");
    let plain = tree.write("plain.yaml", &body);
    let marked = tree.write("marked.yaml", &format!("\u{feff}{body}"));

    let quantities = |path: &PathBuf| -> serde_json::Value {
        let run = execute(&[&path.to_string_lossy()]);
        assert_answered(&run, "a byte-order mark");
        assert_eq!(run.code, Some(0), "{}", run.stderr);
        reports(&run)[0]["quantities"].clone()
    };
    let without = quantities(&plain);
    assert_eq!(without[0]["value"], QUANTITY, "the control case is broken");
    assert_eq!(without[0]["column"], 6);
    assert_eq!(
        quantities(&marked),
        without,
        "a byte-order mark changed what the document says"
    );
}

/// **Never silently absent.** Invalid UTF-8 with no NUL byte looked like
/// text and was not: it keeps a report line with a `skipped` diagnostic
/// and fails `--strict`, because a *text* file that vanishes from the
/// report reads to whoever ran it as a file that was clean.
#[test]
fn an_invalid_utf8_file_is_named_rather_than_dropped() {
    let tree = Tree::new("invalid-utf8");
    tree.write("good.env", &format!("TTL={QUANTITY}\n"));
    tree.write_bytes("notes.txt", &[b'h', b'i', 0xff, 0xfe]);

    let run = execute(&[&tree.text()]);
    assert_answered(&run, "invalid utf-8");
    assert_eq!(run.code, Some(0), "one broken file is not a failed run");
    let scanned = reports(&run);
    let named = report_for(&scanned, "notes.txt").expect("the undecodable file is named");
    assert_eq!(named["diagnostics"][0]["code"], "skipped");
    assert_eq!(named["diagnostics"][0]["message"], "not UTF-8 text");
    assert_eq!(
        execute(&["--strict", &tree.text()]).code,
        Some(2),
        "--strict is how a pipeline refuses it"
    );
}

/// A UTF-16 document is what Notepad writes when asked for "Unicode",
/// and every second byte of ASCII text in it is NUL. So it is **binary**
/// by ripgrep's test: no report line, counted on stderr, and never a
/// `--strict` failure.
///
/// Pinned rather than improved. Decoding it would mean guessing an
/// encoding, and the count is what keeps the reader from believing the
/// scan covered it.
#[test]
fn a_utf16_document_is_counted_as_binary_rather_than_read_as_mojibake() {
    let tree = Tree::new("utf16");
    tree.write("good.env", &format!("TTL={QUANTITY}\n"));
    tree.write_bytes("wide.txt", &utf16le_with_bom(&format!("ttl {QUANTITY}\n")));

    let run = execute(&[&tree.text()]);
    assert_answered(&run, "a utf-16 document");
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    assert!(
        report_for(&reports(&run), "wide.txt").is_none(),
        "a binary file produced a report line"
    );
    assert!(
        run.stderr.contains("1 binary file skipped"),
        "the count is the reader's only sign coverage was narrower: {}",
        run.stderr
    );
    assert_eq!(
        execute(&["--strict", &tree.text()]).code,
        Some(0),
        "a binary file never fails --strict"
    );
}

/// An empty file is a report line saying it holds nothing, not a silence
/// that looks the same as a file the walk never reached.
#[test]
fn an_empty_file_is_a_report_line_and_not_a_silence() {
    let tree = Tree::new("empty");
    tree.write("empty.yaml", "");
    tree.write("whitespace.yaml", "   \n\t\n \n");

    let run = execute(&[&tree.text()]);
    assert_answered(&run, "an empty file");
    assert_eq!(
        run.code,
        Some(1),
        "nothing found is an answer, not an error"
    );
    let scanned = reports(&run);
    assert_eq!(scanned.len(), 2, "a file produced no line at all");
    for report in &scanned {
        assert_eq!(report["summary"]["quantities"], 0);
        assert_eq!(
            report["diagnostics"].as_array().expect("diagnostics").len(),
            0,
            "an empty file is readable, not skipped"
        );
    }
}

/// A minified or generated file is one very long line, and that is where
/// a column lookup counting from the line start turns quadratic — the
/// shape ips-le found. Several megabytes on one line, in the format most
/// likely to be minified.
///
/// `tests/budget.rs` measures the slope; this asserts the thing that
/// matters to a person, which is that the run ends.
#[test]
fn a_multi_megabyte_single_line_json_completes() {
    let tree = Tree::new("minified");
    let entries = 250_000;
    let mut body = String::with_capacity(entries * 24);
    body.push('{');
    for index in 0..entries {
        if index > 0 {
            body.push(',');
        }
        let _ = write!(body, "\"k{index}\":\"{QUANTITY}\"");
    }
    body.push('}');
    assert!(body.len() > 3_000_000, "the case is not big enough to bite");
    let file = tree.write("bundle.json", &body);

    let started = Instant::now();
    let run = execute(&[&file.to_string_lossy()]);
    assert_answered(&run, "a multi-megabyte single line");
    eprintln!(
        "hazards: {} bytes on one line in {:?}",
        body.len(),
        started.elapsed()
    );
    let report = &reports(&run)[0];
    assert_eq!(report["summary"]["quantities"], entries);
    assert_eq!(
        report["quantities"][0]["line"], 1,
        "the whole document is one line"
    );
}

/// **Pinned because it is surprising, and the surprise is the reader's
/// rather than this crate's.** The `csv` crate treats end of file as
/// closing an open quote, so a truncated export is read as data and
/// reports no error. Detecting it would mean writing a second CSV lexer
/// to disagree with the first.
///
/// The failure this pins against is a well-meant "fix" that starts
/// refusing the file — which would drop every row a truncated export
/// still holds.
#[test]
fn an_unterminated_quote_in_a_csv_is_read_to_the_end_of_the_file() {
    let tree = Tree::new("csv-quote");
    let file = tree.write("export.csv", "30s,\"1h30m");

    let run = execute(&[&file.to_string_lossy()]);
    assert_answered(&run, "an unterminated quote");
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    let report = &reports(&run)[0];
    let values: Vec<&str> = report["quantities"]
        .as_array()
        .expect("rows")
        .iter()
        .filter_map(|row| row["value"].as_str())
        .collect();
    assert_eq!(values, ["30s", "1h30m"], "the open cell reached the end");
    assert_eq!(
        report["diagnostics"].as_array().expect("diagnostics").len(),
        0,
        "the reader reports no error, and this pins that it does not start to"
    );
}

// ------------------------------------------------------------- filesystem

/// **The hang this file exists for.** A FIFO with no writer blocks a
/// `read` forever. The walk classifies it as not-a-file and never opens
/// it, whether it is inside a tree or named outright — and the deadline
/// in `execute` is what makes that a check rather than a belief.
#[cfg(unix)]
#[test]
fn a_named_pipe_never_blocks_the_run() {
    let tree = Tree::new("fifo");
    tree.write("good.env", &format!("TTL={QUANTITY}\n"));
    let fifo = tree.path().join("pipe.yaml");
    // Shelled out rather than called through libc: `unsafe` is forbidden
    // crate-wide and a test is not an exemption.
    let made = Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .is_ok_and(|status| status.success());
    if !made {
        skipped("a named pipe", "mkfifo is not available on this runner");
        return;
    }

    let walked = execute(&[&tree.text()]);
    assert_answered(&walked, "a named pipe in a tree");
    assert_eq!(walked.code, Some(0), "{}", walked.stderr);
    let scanned = reports(&walked);
    assert!(report_for(&scanned, "good.env").is_some(), "{scanned:?}");
    assert!(
        report_for(&scanned, "pipe.yaml").is_none(),
        "a named pipe was opened as a document"
    );

    let named = execute(&[&fifo.to_string_lossy()]);
    assert_answered(&named, "a named pipe named outright");
    assert!(named.stdout.is_empty(), "a named pipe produced a report");
}

#[cfg(not(unix))]
#[test]
fn a_named_pipe_never_blocks_the_run() {
    skipped("a named pipe", "Windows has no FIFO in a directory tree");
}

/// A file the filesystem refuses to open, beside one it does not. Being
/// unreadable is a fact about the tree, not a malformed question, so the
/// run answers for everything else and names this one.
#[cfg(unix)]
#[test]
fn a_permission_denied_file_is_named_and_does_not_end_the_run() {
    use std::os::unix::fs::PermissionsExt;

    let tree = Tree::new("denied");
    tree.write("open.env", &format!("TTL={QUANTITY}\n"));
    let closed = tree.write("closed.env", "TTL=1h\n");
    std::fs::set_permissions(&closed, std::fs::Permissions::from_mode(0o000))
        .expect("an unreadable file");

    if std::fs::read(&closed).is_ok() {
        skipped(
            "a permission-denied file",
            "this runner reads a mode-000 file anyway (root)",
        );
        return;
    }

    let run = execute(&[&tree.text()]);
    assert_answered(&run, "a permission-denied file");
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    let denied = report_for(&reports(&run), "closed.env")
        .expect("the unreadable file is named rather than dropped")
        .clone();
    assert_eq!(denied["diagnostics"][0]["code"], "skipped");
    assert_eq!(execute(&["--strict", &tree.text()]).code, Some(2));
}

#[cfg(not(unix))]
#[test]
fn a_permission_denied_file_is_named_and_does_not_end_the_run() {
    skipped(
        "a permission-denied file",
        "Windows ACLs are not chmod; the unix case covers the read failure",
    );
}

#[cfg(unix)]
fn symlink(original: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(original, link)
}

/// Windows needs Developer Mode or an elevated process to create one, so
/// a failure here is the platform refusing rather than the code being
/// wrong — the caller skips by name.
#[cfg(windows)]
fn symlink(original: &Path, link: &Path) -> std::io::Result<()> {
    if original.is_dir() {
        return std::os::windows::fs::symlink_dir(original, link);
    }
    std::os::windows::fs::symlink_file(original, link)
}

/// `follow_links(false)` is what makes this terminate, and nothing else
/// asserts it. On its own in a tree, with nothing beside it to hide a
/// hang behind.
#[test]
fn a_symlink_loop_terminates() {
    let tree = Tree::new("loop");
    tree.write("good.env", &format!("TTL={QUANTITY}\n"));
    let inner = tree.path().join("inner");
    std::fs::create_dir_all(&inner).expect("a directory");
    if symlink(tree.path(), &inner.join("up")).is_err() {
        skipped(
            "a symlink loop",
            "this platform refused to create a symlink",
        );
        return;
    }

    let run = execute(&[&tree.text()]);
    assert_answered(&run, "a symlink loop");
    assert!(
        report_for(&reports(&run), "good.env").is_some(),
        "the loop took the rest of the tree with it: {}",
        run.stderr
    );
}

/// Where Windows differs: `MAX_PATH` is 260 characters unless long paths
/// are enabled, so the creation itself is the platform's answer. The
/// assertion is that the walk answers for the ordinary file beside it
/// either way — a tree that reports nothing because one path was too
/// long is the failure.
#[test]
fn a_path_over_260_characters_is_read_or_refused_cleanly() {
    let tree = Tree::new("long-path");
    tree.write("good.env", &format!("TTL={QUANTITY}\n"));

    let mut deep = String::new();
    while deep.len() < 300 {
        deep.push_str("a-directory-with-a-long-name/");
    }
    deep.push_str("limits.env");
    let created = std::fs::create_dir_all(
        tree.path()
            .join(&deep)
            .parent()
            .expect("a parent directory"),
    )
    .and_then(|()| std::fs::write(tree.path().join(&deep), "TTL=1h\n"))
    .is_ok();
    if !created {
        skipped(
            "a path over 260 characters",
            "this platform refused to create one",
        );
    }

    let run = execute(&[&tree.text()]);
    assert_answered(&run, "a path over 260 characters");
    let scanned = reports(&run);
    assert!(
        report_for(&scanned, "good.env").is_some(),
        "a long path took the rest of the tree with it: {}",
        run.stderr
    );
    if created {
        assert!(
            report_for(&scanned, "limits.env").is_some(),
            "the file was created and then never read: {}",
            run.stderr
        );
    }
}

// ------------------------------------------------------------- exit codes

/// **Exit 2 is for a malformed question and nothing else.** A file the
/// filesystem refused is a fact about the tree; one of those must never
/// end an audit of everything beside it, and a refusal must never write
/// to the protocol stream.
#[test]
fn exit_two_is_for_a_malformed_question_and_writes_no_report() {
    let tree = Tree::new("questions");
    tree.write("good.env", &format!("TTL={QUANTITY}\n"));

    for malformed in [
        vec!["--nonsense", &tree.text()],
        vec!["--format"],
        vec!["--dimension"],
        vec!["--dimension", "length", &tree.text()],
        vec!["--stdin", &tree.text()],
        vec!["/no/such/place-xyz"],
        vec![],
    ] {
        let run = execute(&malformed);
        assert_answered(&run, "a malformed question");
        assert_eq!(run.code, Some(2), "{malformed:?}\n{}", run.stderr);
        assert!(
            run.stdout.is_empty(),
            "{malformed:?} wrote to the protocol stream"
        );
    }
}
