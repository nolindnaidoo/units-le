//! A wall-clock ceiling on a fixed tree, and three linearity checks
//! under it.
//!
//! secrets-le was fifty times slower than its siblings for a whole
//! release and nobody noticed, because nothing measured it. A ceiling
//! this generous catches an order of magnitude and nothing finer — which
//! is the only thing worth catching on a shared runner.
//!
//! **The tree is generated from a fixed seed, not checked in.** Five
//! hundred near-identical config files in git would be five hundred a
//! reviewer has to ignore, and the shape is what matters rather than the
//! bytes. The seed is fixed and printed, so a slow run is reproducible.
//!
//! Three directions, because this crate grows in three:
//!
//! - **four times the files** must not cost six times the clock;
//! - **four times the quantities in one file** must not either — every
//!   value searches forward for its own source text, and a shared cursor
//!   is what keeps that linear rather than a rescan per value;
//! - **four times the quantities on one non-ASCII line** must not
//!   either. That is the shape ips-le found: a UTF-16 column index that
//!   re-counts from the line start on every lookup is invisible on
//!   ordinary source and quadratic on a minified file, where the whole
//!   document is one line. `extract/position.rs` had exactly it — the
//!   ASCII fast path covered the common case and nothing covered the
//!   rest, and before the memo four times the quantities cost **15.7x**
//!   the clock. This is the assertion that fails if the memo is ever
//!   removed as a tidy-up.
//!
//! Gated behind `UNITS_LE_BUDGET` because it is a timing test: it has no
//! business running on a laptop mid-edit, and CI runs it on one platform
//! with `--test-threads=1` — a timing assertion measured against six
//! other tests on the same cores is noise. A skipped run says so by name
//! rather than passing.
//!
//! ## The measurement
//!
//! Taken 2026-08-12 on an Apple M-series laptop (macOS 25.4, `cargo test
//! --release`), warm page cache, best of three runs after a warm-up:
//!
//! ```text
//! one tree  (500 files):   41 ms
//! four      (2000 files): 159 ms  — 3.8x, against a 6x allowance
//! 10k values in one file:  20 ms
//! 40k values in one file:  75 ms  — 3.8x
//! 8k on one non-ascii line: 11 ms
//! 32k on one non-ascii line: 39 ms — 3.5x, and 15.7x before the memo
//! ```
//!
//! The ceiling is 10x the first of those: 420 ms. It bounds an order of
//! magnitude, not a benchmark, and a GitHub runner is slower than this
//! laptop — if it lands near the line, re-measure there and say so in
//! this note rather than quietly raising the number.

use std::fmt::Write as _;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

const BINARY: &str = env!("CARGO_BIN_EXE_units-le");
static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// 10x the local measurement recorded in the module note.
const CEILING: Duration = Duration::from_millis(420);

/// Four times the work, at most six times the clock. Anything quadratic
/// blows through this; ordinary variance does not.
const LINEARITY: f64 = 6.0;

/// Printed on every run, so a failure names the corpus that was slow.
const SEED: u64 = 20_260_812;

const FILES_PER_COPY: usize = 500;

fn enabled(name: &str) -> bool {
    if std::env::var_os("UNITS_LE_BUDGET").is_some() {
        return true;
    }
    eprintln!("SKIPPED {name}: set UNITS_LE_BUDGET to run it");
    false
}

/// A tiny xorshift, so the corpus is the same corpus on every machine and
/// every run without a dependency to get there.
struct Seeded(u64);

impl Seeded {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: usize) -> usize {
        usize::try_from(self.next() % bound.max(1) as u64).unwrap_or(0)
    }

    fn pick<'a, T>(&mut self, from: &'a [T]) -> &'a T {
        let index = self.below(from.len());
        &from[index]
    }
}

struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new(name: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "units-le-budget-{name}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a temporary directory");
        Self { root }
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// The shapes a real checkout is made of: config in every format the
/// crate parses, plus the manifests and prose the text scan reads. A
/// refusal in every file too, because the refusal path is the product and
/// measuring only the happy one would measure half the tool.
const SHAPES: [(&str, &str); 8] = [
    ("yaml", "timeout: {D}\nmemory: {B}\ncpu: 500m\nshare: {P}\n"),
    (
        "json",
        "{{\"timeout\":\"{D}\",\"memory\":\"{B}\",\"cpu\":\"500m\",\"rate\":\"{F}\"}}\n",
    ),
    (
        "toml",
        "timeout = \"{D}\"\nmemory = \"{B}\"\ncpu = \"1.5KB\"\nrate = \"{F}\"\n",
    ),
    (
        "ini",
        "[limits]\ntimeout = {D}\nmemory = {B}\nlatency = 1,5s\n",
    ),
    ("env", "TIMEOUT={D}\nMEMORY={B}\nCPU=500m\nSHARE={P}\n"),
    ("csv", "{D},{B},{P}\n{F},500m,1.5KB\n"),
    (
        "md",
        "The cache holds {B} for {D}, sampling at {F}. Budget is {P} of 1h + 30m.\n",
    ),
    (
        "tf",
        "  timeout = \"{D}\"\n  # holds {B} at {F}\n  cpu = \"500m\"\n",
    ),
];

fn body(seeded: &mut Seeded, template: &str) -> String {
    template
        .replace(
            "{D}",
            &format!("{}h{}m", seeded.below(24), seeded.below(60)),
        )
        .replace("{B}", &format!("{}MiB", 1 + seeded.below(4096)))
        .replace("{P}", &format!("{}%", seeded.below(100)))
        .replace(
            "{F}",
            &format!("{}.{}kHz", 1 + seeded.below(48), seeded.below(10)),
        )
}

/// One copy of the tree: `FILES_PER_COPY` files under `prefix`, spread
/// over directories so the walk has something to walk.
fn populate(root: &Path, prefix: &str, seeded: &mut Seeded) {
    for index in 0..FILES_PER_COPY {
        let (extension, template) = *seeded.pick(&SHAPES);
        let mut content = String::new();
        for _ in 0..12 {
            content.push_str(&body(seeded, template));
        }
        let directory = root.join(format!("{prefix}/pkg{}", index % 25));
        std::fs::create_dir_all(&directory).expect("a directory");
        std::fs::write(directory.join(format!("file{index}.{extension}")), &content)
            .expect("a file");
    }
}

/// Time one scan of a tree, asserting it answered rather than refused.
fn scan_tree(root: &Path) -> Duration {
    let started = Instant::now();
    let output = Command::new(BINARY)
        .arg(root)
        .output()
        .expect("the binary runs");
    let elapsed = started.elapsed();
    assert_eq!(
        output.status.code(),
        Some(0),
        "the scan did not finish: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stdout.len() > 1000,
        "the scan reported almost nothing, so it measured almost nothing"
    );
    elapsed
}

/// Time one scan of a document on stdin. Nothing touches the filesystem,
/// so what is measured is extraction and locating rather than the walk.
fn scan_document(content: &str, format: &str) -> Duration {
    let started = Instant::now();
    let mut child = Command::new(BINARY)
        .args(["--stdin", "--format", format])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the binary runs");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(content.as_bytes())
        .expect("the child is still reading");
    drop(child.stdin.take());
    let output = child.wait_with_output().expect("the child finishes");
    let elapsed = started.elapsed();
    assert_eq!(
        output.status.code(),
        Some(0),
        "the scan found nothing, so it measured nothing"
    );
    elapsed
}

/// The fastest of three runs, after a warm-up. The fastest, not the mean:
/// a shared runner pauses for reasons that have nothing to do with this
/// code, and the question is what the work costs rather than what the
/// neighbours cost.
fn fastest(mut measure: impl FnMut() -> Duration) -> Duration {
    let _ = measure();
    (0..3).map(|_| measure()).min().expect("three runs")
}

/// One long line of `count` quantities, ASCII or not. The non-ASCII
/// variant is the one that matters: it is what forces a UTF-16 column
/// count rather than the arithmetic fast path.
fn one_long_line(count: usize, ascii: bool) -> String {
    let lead = if ascii { "ttl" } else { "caf\u{e9}" };
    let mut out = String::with_capacity(count * 20);
    for index in 0..count {
        let _ = write!(out, "{lead}{index}={}ms; ", index % 999 + 1);
    }
    out
}

#[test]
fn a_five_hundred_file_tree_scans_inside_its_budget() {
    if !enabled("a_five_hundred_file_tree_scans_inside_its_budget") {
        return;
    }
    let tree = Tree::new("ceiling");
    populate(&tree.root, "one", &mut Seeded(SEED));

    let elapsed = fastest(|| scan_tree(&tree.root));
    eprintln!("budget: {FILES_PER_COPY} files scanned in {elapsed:?} (seed {SEED})");
    assert!(
        elapsed <= CEILING,
        "seed {SEED}: {FILES_PER_COPY} files took {elapsed:?}, over the {CEILING:?} ceiling — \
         10x the recorded local measurement, so this is an order of magnitude, not variance"
    );
}

#[test]
fn four_times_the_tree_is_not_six_times_the_clock() {
    if !enabled("four_times_the_tree_is_not_six_times_the_clock") {
        return;
    }
    let small = Tree::new("linear-one");
    let large = Tree::new("linear-four");
    populate(&small.root, "one", &mut Seeded(SEED));
    for copy in 0..4 {
        populate(&large.root, &format!("copy{copy}"), &mut Seeded(SEED));
    }

    let one = fastest(|| scan_tree(&small.root));
    let four = fastest(|| scan_tree(&large.root));
    let ratio = four.as_secs_f64() / one.as_secs_f64().max(f64::EPSILON);
    eprintln!("budget: one tree {one:?}, four trees {four:?}, ratio {ratio:.2}x (seed {SEED})");
    assert!(
        ratio <= LINEARITY,
        "seed {SEED}: four times the tree took {ratio:.2}x as long ({one:?} then {four:?}), \
         over the {LINEARITY}x allowance — that is the shape of something quadratic"
    );
}

/// Four times the quantities in **one** document. Every value in a
/// structured format searches forward through the text for its own
/// source spelling; a shared cursor keeps that one pass, and a search
/// that restarted at the top of the document per value would take
/// sixteen times as long here and nowhere else.
#[test]
fn four_times_the_quantities_in_one_file_is_not_six_times_the_clock() {
    if !enabled("four_times_the_quantities_in_one_file_is_not_six_times_the_clock") {
        return;
    }
    let document = |rows: usize| {
        (0..rows).fold(String::new(), |mut out, index| {
            let _ = writeln!(out, "k{index}: \"{}ms\"", index % 999 + 1);
            out
        })
    };
    let small = document(10_000);
    let large = document(40_000);

    let one = fastest(|| scan_document(&small, "yaml"));
    let four = fastest(|| scan_document(&large, "yaml"));
    let ratio = four.as_secs_f64() / one.as_secs_f64().max(f64::EPSILON);
    eprintln!("budget: 10k values {one:?}, 40k values {four:?}, ratio {ratio:.2}x");
    assert!(
        ratio <= LINEARITY,
        "four times the values in one document cost {ratio:.2}x the time (limit {LINEARITY}x) — \
         the forward cursor in extract/locate.rs is what keeps this one pass"
    );
}

/// **The one ips-le found.** A minified file is one very long line, and a
/// column counted in UTF-16 units from the line start on every lookup is
/// quadratic there. The ASCII document is the control: it takes the
/// arithmetic fast path and cannot show the defect, so a run where only
/// the non-ASCII ratio blows up is exactly the bug.
#[test]
fn four_times_the_quantities_on_one_non_ascii_line_is_not_six_times_the_clock() {
    if !enabled("four_times_the_quantities_on_one_non_ascii_line_is_not_six_times_the_clock") {
        return;
    }
    for ascii in [true, false] {
        let small = one_long_line(8_000, ascii);
        let large = one_long_line(32_000, ascii);
        let one = fastest(|| scan_document(&small, "unknown"));
        let four = fastest(|| scan_document(&large, "unknown"));
        let ratio = four.as_secs_f64() / one.as_secs_f64().max(f64::EPSILON);
        eprintln!("budget: one line, ascii={ascii}: 8k {one:?}, 32k {four:?}, ratio {ratio:.2}x");
        assert!(
            ratio <= LINEARITY,
            "ascii={ascii}: four times the quantities on one line cost {ratio:.2}x the time \
             (limit {LINEARITY}x) — the memo in extract/position.rs is what keeps the UTF-16 \
             column count from restarting at the line start on every lookup"
        );
    }
}
