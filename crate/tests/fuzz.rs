//! A standing net over the grammar, the exact-decimal arithmetic and the
//! text scan.
//!
//! Time-boxed, not run to convergence: the point is that a panic, a hang,
//! a slice off a character boundary or a wrapped byte count has somewhere
//! to be caught, not that the input space is proved. Sixty seconds in CI,
//! one second on a bare `cargo test`, so the net is present on every push
//! without owning the run.
//!
//! **The overflow leg is why this runs in release.** `overflow-checks` is
//! on in the release profile, deliberately: every base value is an
//! integer multiplication against a `PiB` count or a nanosecond scale,
//! and a build that wrapped would report a confident, wrong number.
//! `extract/decimal.rs` refuses before it reaches that backstop, and the
//! generator here writes the magnitudes that reach for it — an
//! out-of-range quantity must come back as `out_of_range`, never as a
//! panic and never as a number.
//!
//! **Why not cargo-fuzz or proptest.** cargo-fuzz needs a library target
//! and this crate is a binary; `extract/` is `pub(crate)` and reachable
//! from an integration test only through a frontend. proptest would put a
//! dependency tree in the published tarball's `cargo test` for shrinking
//! that a time-boxed run does not use. So: a seeded generator, a wall
//! clock, and the built binary's MCP server — one process, one request
//! per line, the thinnest shell there is around `extract/`. A panic kills
//! that process and the loop names the document that did it.
//!
//! Reproduce a failure with the seed and the document it prints:
//! `UNITS_LE_FUZZ_SEED=… UNITS_LE_FUZZ_SECONDS=… cargo test --release
//! --test fuzz -- --nocapture`.

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

const BINARY: &str = env!("CARGO_BIN_EXE_units-le");

/// One document may not take longer than this. A true infinite loop is
/// caught by the job's own timeout; this catches the realistic shape — a
/// document that turns a linear scan quadratic.
const CASE_LIMIT: Duration = Duration::from_secs(5);

/// Seconds of fuzzing. CI passes 60; a bare `cargo test` runs one.
fn budget() -> Duration {
    let seconds = std::env::var("UNITS_LE_FUZZ_SECONDS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .unwrap_or(1);
    Duration::from_secs(seconds)
}

/// Printed on every run, failing or not: a fuzz failure nobody can
/// reproduce is a fuzz failure nobody fixes.
fn seed() -> u64 {
    std::env::var("UNITS_LE_FUZZ_SEED")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .unwrap_or(0x0020_2608_1200_0001)
}

/// splitmix64: seeded, reproducible on every platform, no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, bound: usize) -> usize {
        if bound == 0 {
            return 0;
        }
        usize::try_from(self.next() % bound as u64).unwrap_or(0)
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

// ------------------------------------------------------------- the corpus

/// Every symbol the grammar resolves. A generated token pairs one of
/// these with a hostile number, so the arithmetic is reached rather than
/// only the lexer.
const KNOWN: [&str; 41] = [
    "ns", "us", "\u{b5}s", "\u{3bc}s", "ms", "s", "sec", "secs", "min", "mins", "h", "hr", "hrs",
    "d", "day", "days", "w", "B", "kB", "KB", "MB", "GB", "TB", "PB", "KiB", "MiB", "GiB", "TiB",
    "PiB", "Ki", "Mi", "Gi", "Ti", "Pi", "Hz", "kHz", "KHz", "MHz", "GHz", "THz", "%",
];

/// Every symbol the grammar refuses by name. The generator puts each of
/// them in every position a symbol can occupy — alone, inside a compound,
/// inside an expression, after an ISO prefix — because a refusal that
/// only holds in one position is a refusal that leaks.
const AMBIGUOUS: [&str; 18] = [
    "m", "M", "k", "K", "G", "T", "P", "y", "Y", "b", "kb", "Kb", "mb", "Mb", "gb", "Gb", "tb",
    "Tb",
];

/// Decimal separators as several locales write them, plus the shapes that
/// are not separators at all. `1,5` is one and a half in one place and
/// fifteen hundred in another; this tool refuses rather than inferring a
/// locale, and the refusal has to hold for every one of these.
const SEPARATORS: [&str; 14] = [
    "1,5", "1.000", "1.500", "1,000", "1 000", "1'000", "1.2.3", "1,,5", ",5", ".5", "0.825",
    "1.0", "-1,5", "1.",
];

/// The magnitudes that reach for the overflow backstop.
const HUGE: [&str; 8] = [
    "999999999999",
    "999999999999999999999999999999999999",
    "99999999999999999999999999999999999999999",
    "340282366920938463463374607431768211455",
    "340282366920938463463374607431768211456",
    "1000000000000000000000000000000000000000000000000",
    "0.99999999999999999999999999999999999999999",
    "-99999999999999999999999999999999999999",
];

/// A number with no unit attached — hostile because every one of them
/// must yield **nothing**, which is the boundary that keeps this tool and
/// numbers-le distinct.
const BARE: [&str; 6] = ["0", "-0", "30", "0.5", "1e3", "0x1d"];

/// One quantity-shaped token, from the families this crate is most
/// likely to get wrong.
fn token(rng: &mut Rng) -> String {
    match rng.below(12) {
        // An enormous digit run: past the 38 digits a u128 mantissa
        // holds, so the parse itself has to refuse.
        0 => format!("{}{}", "9".repeat(1 + rng.below(4_000)), rng.pick(&KNOWN)),
        // The overflow families, against the units with the largest
        // multipliers.
        1 => format!("{}{}", rng.pick(&HUGE), rng.pick(&KNOWN)),
        2 => format!(
            "{}{}",
            rng.pick(&HUGE),
            rng.pick(&["PiB", "PB", "w", "THz"])
        ),
        // A deeply chained compound. Descending order is required, so a
        // repeated chain stops being a quantity after the first cycle —
        // which is the point: it must stop being one rather than become
        // an expensive one.
        3 => "1h30m45s500ms".repeat(1 + rng.below(400)),
        4 => {
            let mut out = String::new();
            for (index, unit) in ["w", "d", "h", "min", "s", "ms", "us", "ns"]
                .iter()
                .enumerate()
            {
                let _ = write!(out, "{}{unit}", index + 1);
            }
            out.repeat(1 + rng.below(200))
        }
        // Every ambiguous symbol, in every position it can occupy.
        5 => format!("{}{}", 1 + rng.below(1000), rng.pick(&AMBIGUOUS)),
        6 => format!("1h30{}", rng.pick(&AMBIGUOUS)),
        7 => format!("1h + 30{}", rng.pick(&AMBIGUOUS)),
        // Locale-shaped separators.
        8 => format!("{}{}", rng.pick(&SEPARATORS), rng.pick(&KNOWN)),
        // ISO-8601 with an absurd component count.
        9 => {
            let body = "1Y2M3W4D".repeat(1 + rng.below(150));
            let time = "5H6M7S".repeat(1 + rng.below(150));
            format!("P{body}T{time}")
        }
        10 => format!("PT{}", "1S".repeat(1 + rng.below(600))),
        // Negative and zero quantities, which are quantities and not
        // subtractions.
        _ => format!(
            "{}{}{}",
            rng.pick(&["-", "+", "-0", "0", ""]),
            rng.below(3),
            rng.pick(&KNOWN)
        ),
    }
}

/// Filler between tokens: the boundary characters are what decide whether
/// a run may start at all, so they are the interesting part.
const GLUE: [&str; 20] = [
    " ",
    "\t",
    "\n",
    "\r\n",
    ",",
    ";",
    ":",
    "=",
    "/",
    "+",
    "-",
    "_",
    ".",
    "\"",
    "'",
    "#",
    // Wider than one byte, so a column is a UTF-16 count rather than a
    // byte offset, and a slice on the wrong boundary aborts.
    "\u{e9}",
    "\u{1f3af}",
    "\u{4e2d}\u{6587}",
    "\u{feff}",
];

/// A document, in whichever format it will be read as. The structured
/// formats take the whole value as a candidate, so a token has to arrive
/// as a value; the text scan takes runs, so it has to arrive in prose.
fn document(rng: &mut Rng, format: &str) -> String {
    let pieces = 1 + rng.below(30);
    let mut out = String::new();
    for index in 0..pieces {
        let value = if rng.below(6) == 0 {
            (*rng.pick(&BARE)).to_string()
        } else {
            token(rng)
        };
        let _ = match format {
            "json" => write!(
                out,
                "{}\"k{index}\":\"{value}\"",
                if index > 0 { "," } else { "" }
            ),
            "yaml" => writeln!(out, "k{index}: \"{value}\""),
            "toml" => writeln!(out, "k{index} = \"{value}\""),
            "ini" => writeln!(out, "k{index} = {value}"),
            "env" => writeln!(out, "K{index}={value}"),
            "csv" => writeln!(out, "{value},{}", rng.pick(&BARE)),
            _ => write!(out, "{}{value}{}", rng.pick(&GLUE), rng.pick(&GLUE)),
        };
    }
    if format == "json" {
        return format!("{{{out}}}");
    }
    if format == "ini" {
        return format!("[section]\n{out}");
    }
    out
}

const FORMATS: [&str; 7] = ["json", "yaml", "toml", "ini", "env", "csv", "unknown"];

// -------------------------------------------------------------- the server

/// A server held open across the whole run: spawning a process per case
/// would measure `fork`, not the grammar.
struct Server {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<Option<String>>,
}

impl Server {
    fn start() -> Self {
        let mut child = Command::new(BINARY)
            .arg("mcp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the server starts");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");

        // Read on a thread so a document that never answers is a timeout
        // naming its body rather than a blocked test.
        let (sender, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if sender.send(line.ok()).is_err() {
                    return;
                }
            }
            let _ = sender.send(None);
        });

        Self {
            child,
            stdin,
            lines,
        }
    }

    fn extract(&mut self, case: &str, content: &str, format: &str) -> String {
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "extract_units",
                // Above any document this generates, so `truncated` never
                // hides a row the assertions were going to read.
                "arguments": { "content": content, "format": format, "maxResults": 5000 },
            },
        });
        writeln!(self.stdin, "{request}")
            .unwrap_or_else(|error| panic!("{case}: the server stopped reading ({error})"));
        self.stdin
            .flush()
            .unwrap_or_else(|error| panic!("{case}: could not flush ({error})"));

        match self.lines.recv_timeout(CASE_LIMIT) {
            Ok(Some(line)) => line,
            Ok(None) => panic!("{case}: the server died — a panic, an abort, or an overflow"),
            Err(RecvTimeoutError::Timeout) => {
                panic!("{case}: no answer in {CASE_LIMIT:?} — the scan is not terminating")
            }
            Err(RecvTimeoutError::Disconnected) => panic!("{case}: the server closed stdout"),
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Every non-ASCII character escaped, so a failing document pastes
/// straight into a test.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for character in text.chars().take(4_000) {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_ascii_graphic() || c == ' ' => out.push(c),
            c => {
                let _ = write!(out, "\\u{{{:x}}}", c as u32);
            }
        }
    }
    out.push('"');
    out
}

const DIMENSIONS: [&str; 4] = ["duration", "bytes", "percent", "frequency"];
const REASONS: [&str; 6] = [
    "ambiguous_unit",
    "fractional_bytes",
    "locale_separator",
    "compound_arithmetic",
    "si_iec_hazard",
    "out_of_range",
];

/// Every invariant the report shape carries, asserted on one answer.
///
/// The load-bearing one is the last: **a row with no base value must name
/// a reason**. That is the whole product — a refusal is a finding — and
/// it is also the overflow assertion, because a magnitude that does not
/// fit reaches this as `out_of_range` rather than as a wrapped number or
/// a dead process.
fn check(case: &str, content: &str, format: &str, raw: &str) {
    let blame = || {
        format!(
            "\n  seed:     {}\n  format:   {format}\n  document: {}",
            seed(),
            escape(content)
        )
    };

    let response: serde_json::Value = serde_json::from_str(raw)
        .unwrap_or_else(|error| panic!("{case}: the answer is not JSON ({error}){}", blame()));
    assert!(
        response.get("error").is_none(),
        "{case}: the tool call failed — {raw}{}",
        blame()
    );
    let envelope = &response["result"]["structuredContent"];
    assert_eq!(
        envelope["meta"]["tool"], "extract_units",
        "{case}: not the tool's envelope — {raw}"
    );
    assert!(envelope["ok"].is_boolean(), "{case}: {raw}");
    assert_eq!(
        response["result"]["isError"],
        false,
        "{case}: a document is never a malformed question{}",
        blame()
    );

    let rows = envelope["data"]["quantities"]
        .as_array()
        .unwrap_or_else(|| panic!("{case}: quantities is not a list — {raw}"));
    for row in rows {
        let value = row["value"]
            .as_str()
            .unwrap_or_else(|| panic!("{case}: a row has no text{}", blame()));
        assert!(!value.is_empty(), "{case}: an empty value{}", blame());
        // The text scan slices the document, so its findings are
        // evidence from it. A structured format hands over a parsed
        // value, which may legitimately differ from its source spelling.
        if format == "unknown" {
            assert!(
                content.contains(value),
                "{case}: {value:?} was reported but is not in the document{}",
                blame()
            );
        }

        let base = row["base"].as_str();
        let reason = row["reason"].as_str();
        assert!(
            base.is_some() || reason.is_some(),
            "{case}: {value:?} has neither a base value nor a reason — a quantity was \
             silently dropped into a row that says nothing{}",
            blame()
        );
        if let Some(reason) = reason {
            assert!(
                REASONS.contains(&reason),
                "{case}: {reason} is not a reason this crate names{}",
                blame()
            );
            assert_eq!(
                base.is_some(),
                reason == "si_iec_hazard",
                "{case}: {value:?} is {reason} — si_iec_hazard is the one reason that keeps a \
                 base value, and every other one withholds it{}",
                blame()
            );
        }
        if let Some(base) = base {
            assert!(
                !base.contains('e') && !base.contains('E'),
                "{case}: {base} is exponential, and a base value is read against a document \
                 by a person{}",
                blame()
            );
        }
        if let Some(dimension) = row["dimension"].as_str() {
            assert!(
                DIMENSIONS.contains(&dimension),
                "{case}: {dimension} is not one of the four{}",
                blame()
            );
        }
        assert_eq!(
            row["dimension"].is_null(),
            row["baseUnit"].is_null(),
            "{case}: a dimension and its base unit are derived from each other{}",
            blame()
        );
        for field in ["line", "column"] {
            if let Some(number) = row[field].as_u64() {
                assert!(
                    number >= 1,
                    "{case}: {field} {number} is not 1-based{}",
                    blame()
                );
            }
        }
    }
}

// --------------------------------------------------------------- the runs

#[test]
fn the_grammar_survives_everything_thrown_at_it() {
    let seed = seed();
    let budget = budget();
    eprintln!("fuzz: seed {seed}, budget {budget:?}");

    let mut server = Server::start();
    let mut rng = Rng(seed);
    let mut cases = 0usize;

    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        let format = *rng.pick(&FORMATS);
        let content = document(&mut rng, format);
        let case = format!("seed {seed} case {cases}");
        let raw = server.extract(&case, &content, format);
        check(&case, &content, format, &raw);
        cases += 1;
    }

    eprintln!("fuzz: {cases} documents, seed {seed}");
    assert!(cases > 0, "the fuzzer ran no documents");
}

/// **The overflow leg, by name.** A magnitude past what a `u128` mantissa
/// holds, or past what the multiplication into base units fits, must come
/// back as `out_of_range` — never a panic, and never a wrapped number
/// that looks fine. `overflow-checks` in release is the backstop behind
/// this, not instead of it, so a failure here is either a missed check or
/// the backstop firing.
#[test]
fn an_out_of_range_magnitude_is_refused_by_name_rather_than_wrapped() {
    let mut server = Server::start();
    let mut checked = 0;

    for magnitude in HUGE {
        for unit in ["PiB", "PB", "TiB", "w", "ns", "THz", "%"] {
            let token = format!("{magnitude}{unit}");
            // A leading `-` in prose would be read as an operator, so the
            // structured path is the one that asks the question cleanly.
            let content = format!("k: \"{token}\"");
            let case = format!("out of range {token}");
            let raw = server.extract(&case, &content, "yaml");
            check(&case, &content, "yaml", &raw);

            let response: serde_json::Value = serde_json::from_str(&raw).expect("JSON");
            let rows = response["result"]["structuredContent"]["data"]["quantities"]
                .as_array()
                .expect("rows")
                .clone();
            let Some(row) = rows.first() else {
                continue; // not a quantity at all is a fine answer
            };
            if row["base"].is_string() {
                continue; // it fit, which is also a fine answer
            }
            assert_eq!(
                row["reason"], "out_of_range",
                "{token} has no base value for some reason other than not fitting"
            );
            checked += 1;
        }
    }

    // Nine digits past a u128 mantissa against a PiB multiplier cannot
    // fit under any reading, so this can never be a vacuous pass.
    assert!(checked > 0, "no case actually went out of range");
    eprintln!("fuzz: {checked} out-of-range magnitudes refused by name");
}

/// The pathological shapes by name, outside the random path, so a failure
/// says what broke rather than which seed found it.
#[test]
fn the_pathological_shapes_terminate() {
    let mut server = Server::start();
    let deep = (1..=8)
        .zip(["w", "d", "h", "min", "s", "ms", "us", "ns"])
        .fold(String::new(), |mut out, (count, unit)| {
            let _ = write!(out, "{count}{unit}");
            out
        });

    let cases: [(&str, String, &str); 8] = [
        (
            "forty thousand digits",
            format!("k: \"{}s\"", "9".repeat(40_000)),
            "yaml",
        ),
        (
            "a compound repeated a thousand times",
            format!("k: \"{}\"", "1h30m45s500ms".repeat(1_000)),
            "yaml",
        ),
        (
            "the deepest legal compound",
            format!("k: \"{deep}\""),
            "yaml",
        ),
        (
            "an iso duration with a thousand components",
            format!("k: \"PT{}\"", "1S".repeat(1_000)),
            "yaml",
        ),
        (
            "an expression of a thousand terms",
            format!(
                "k: \"{}\"",
                (0..1_000).map(|_| "1h + ").collect::<String>() + "30m"
            ),
            "yaml",
        ),
        (
            "ten thousand quantities on one line",
            (0..10_000).fold(String::new(), |mut out, index| {
                let _ = write!(out, "ttl{index}={index}ms; ");
                out
            }),
            "unknown",
        ),
        (
            "ten thousand quantities on one non-ascii line",
            (0..10_000).fold(String::new(), |mut out, index| {
                let _ = write!(out, "caf\u{e9}{index}={index}ms; ");
                out
            }),
            "unknown",
        ),
        (
            "every ambiguous symbol at once",
            AMBIGUOUS
                .iter()
                .enumerate()
                .fold(String::new(), |mut out, (index, symbol)| {
                    let _ = writeln!(out, "k{index}: \"5{symbol}\"");
                    out
                }),
            "yaml",
        ),
    ];

    for (name, content, format) in cases {
        let started = Instant::now();
        let raw = server.extract(name, &content, format);
        check(name, &content, format, &raw);
        eprintln!("fuzz: {name} answered in {:?}", started.elapsed());
    }
}
