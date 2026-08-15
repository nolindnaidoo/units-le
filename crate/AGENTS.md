# units-le (CLI) — engineering standards

This is the source of truth for how code in `crate/` is written, tested,
and reviewed. It applies to every contributor, human or AI-assisted.
[SPEC.md](SPEC.md) defines the product behavior — the refusal table,
exit codes, both surfaces; this file is how the code gets there.
AGENTS.md wins on any conflict.

## What this project is

The unit-aware sibling of numbers-le. numbers-le extracts numbers and
has no unit concept; this extracts **quantities** — a number with its
unit — and reports each one as the document wrote it *and* in a base
unit, so two of them can be compared.

**Status: published, hardened.** The grammar, the six format
readers, the text scan, both surfaces and the corpus are built and
green, and the family's hardening is in place: the four suites, the
coverage-matrix, the 75% per-module floor on `extract/`, and the CI
workflows that run them. It is **on crates.io**, and this repository
is **crate-only** — there is no extension beside it, so the `parity` and
`differential` jobs the two-frontend siblings run are deliberately
absent rather than present and vacuous.

**The reader is not the author.** Someone reconciling configuration
across services, or against a document that states the limits — an SRE
before a migration, an auditor holding a retention policy next to the
config that implements it. Every decision below follows from that.

## Layout

```
crate/src/
├── extract/     pure: the unit grammar, exact decimals, six format
│                readers, the text scan, positions. No filesystem.
├── walk.rs      ignore-aware tree walking
├── scan.rs      one file end to end — the only path either surface calls
├── cli.rs       the terminal surface
└── mcp/         the agent surface
```

- **`extract/` touches no filesystem.** It takes document text and a
  format and returns quantities, so the entire extraction layer tests
  from a fixture file — no temp directories, no flake. A `std::fs` call
  appearing there is a bug.
- **`scan.rs` and `walk.rs` are the only modules allowed to touch the
  filesystem.**
- **Both surfaces are one implementation.** `cli.rs` and `mcp/` both
  call `scan.rs`, which calls `extract()`. A surface that grows its own
  copy of a rule is a bug, and `tests/contracts.rs` asserts the two
  return identical reports for the same tree.
- **`grammar.rs` is the product.** Everything else moves text around it.
- Keep modules flat. No layers, registries, managers, or services. No
  trait with a single implementation.

## Decisions already made (do not relitigate)

- **A refusal is a finding.** A quantity that cannot be resolved keeps
  its row, its source text, a named reason and a sentence a person can
  act on. It is never a dropped row and never a guess. Every change here
  is measured against that sentence.
- **The grammar is hand-written and pinned in one file.** No
  `byte-unit`, `humantime`, `duration-str` or `uom` — each of them
  resolves the cases this tool exists to refuse. They are fine as
  dev-dependency oracles in tests; they are not runtime dependencies.
  No regex engine either: the grammar is a lexer, and a pattern would
  not express it more clearly.
- **`si_iec_hazard` keeps its base value.** It is the one reason that
  annotates rather than withholds. `MB` is 10^6 by the standard, so that
  is the answer; the hazard is that the writer may have meant 2^20.
  Withholding would be less useful and picking 2^20 would be a guess. It
  does not count as refused and does not trip `--strict`. Changing this
  is a behaviour change, not a tidy-up — `corpus.rs` asserts it.
- **`1h30m` is a grammar; `1h + 30m` is arithmetic.** The compound is
  read as one quantity, the expression is refused as one finding. The
  parts of a compound disambiguate each other — `m` alone is refused and
  `m` between `h` and `s` is minutes — which is why descending order is
  *required* rather than assumed, and why `30s1h` is not a quantity.
- **An operand with no unit is still an operand.** `30s*2` and
  `1h + 30` are `compound_arithmetic`, because reporting `30s` for a
  line that says twice that is the same confident wrong answer as
  reporting `1h` and `30m` separately. *Some* operand must carry a unit,
  which is what keeps `2026-08-12` and `1-2` silent, and a leading sign
  is part of the number rather than an operator, which is what keeps
  `-30s` a quantity. The text scan spans the whole expression from
  either end so the refusal names what it saw.
- **Base values are exact decimals, never `f64`.** A sign, an integer
  mantissa and a power-of-ten scale. `0.1s` through a double is
  `100.00000000000001` ms. Every conversion is a checked integer
  multiply; an overflow is `out_of_range`, not a wrap. `overflow-checks`
  is on in release as the backstop behind that check, not instead of it.
- **`value` and `base` are strings, on both surfaces.** Re-encoding
  through a JSON number hands the reader whatever their parser prints,
  and a byte count past 2^53 comes back as a different number.
- **There is no `unit` field.** The unit is visible in `value`; a field
  repeating it would be a second place for the two to disagree.
- **A bare number is not a finding.** That is numbers-le's question, and
  the boundary is what keeps the two tools distinct. A test asserts it
  in every format.
- **Case is part of a unit symbol.** `MB` is bytes, `Mb` is refused. No
  case folding, ever.
- **Every format is a string harvest.** numbers-le's typed/untyped
  coercion split does not exist here: a unit is spelled in characters,
  so a quantity is a string in all six formats, and a typed value is the
  one thing that can never be a quantity.
- **One extraction function, both surfaces.** numbers-le's shared MCP
  tool omits positions to stay byte-identical with its npm twin; this
  crate has no twin, so a second shape would be two answers to one
  question.
- **A format falls back, a dimension does not.** An unrecognised format
  is the text scan; an unrecognised dimension is exit 2. There is
  nothing for a dimension to fall back to.
- **A refusal that names no dimension survives every filter.**
  Filtering it out would be this tool deciding what it just said it
  could not decide.
- **The text scan has a grammar**, unlike numbers-le's. It also has a
  written-down false-positive class — a run inside a base64 hash or a
  UUID — which is **measured rather than imagined**: 1.8% over
  `fixtures/documents/opaque.txt`, recomputed and printed on every test
  run. The boundary characters that let it through are the same ones
  that let `-30s` and `ttl=30s` through, so narrowing them would cost
  real findings. Tightening this is a behaviour change that needs
  SPEC.md and the CHANGELOG, not a quieter test.
- **A report path is separated by `/` on every platform.** envsync-le
  shipped `\` on Windows for a release; a report is diffed against one
  produced somewhere else, and `scan.rs::report_path` is the one place
  that normalises it.
- **`PositionIndex` counts on from its last answer.** The ASCII fast
  path is not the whole guard: without the memo a UTF-16 column re-counts
  from the line start on every lookup, which is quadratic on a minified
  file and cost 15.7x the clock for four times the quantities. Do not
  remove it as a tidy-up — `tests/budget.rs` asserts the slope.
- **A binary file is not a report.** A NUL byte in the first 8 KiB
  (ripgrep's test) and the file produces no report line and no effect on
  the exit code; it is counted on stderr. A file that *is* text and
  could not be read keeps its `skipped` diagnostic and fails `--strict`.
- **A parse failure is a warning, not an exit 2.** One malformed config
  must not fail an audit of ten thousand files.
- **Exit codes follow grep**: 0 found, 1 none found, 2 could not answer.
  A refusal does not change the exit code unless `--strict`.
- **stdout is protocol, stderr is human. There is no `--json` flag.**
- **One crate, self-contained.** No published `-core`, no shared crate,
  and nothing holding this code equal to the similar files in the
  sibling repos. Where it agrees with numbers-le it is because the same
  answer was right twice.

## Control-flow style

Flat over nested, guards over branches — the same rules as pixelcoords,
pixelactions, scrape-le and numbers-le:

- **No statement-position `else`.** Guard clauses and early `return`
  (`if !ok { return ... }` / `let Some(x) = ... else { return }`), then
  fall through to the happy path.
- **Value-position `if/else` is fine** — `let x = if cond { a } else
  { b }` is Rust's ternary.
- **`match` is fine and preferred** over any chain of condition tests on
  the same value; use match guards instead of `if/else` inside arms.
- Prefer combinators where they read cleanly: `bool::then_some`,
  `Option::map/filter/is_some_and/is_none_or`, `?`.
- No nesting deeper than two levels inside a function; extract a named
  helper instead.
- **Immutable by default.** An iterator chain over an accumulator, and a
  `let mut` only where the loop genuinely carries state — `lex`, the
  scanner's cursor, the walk. Every format reader in `extract/` is a
  chain, and the one that was not read differently from its neighbours
  for no reason a reader could see.
- **Borrow the slice, not the owner**: `&str`, `&[T]`, `&Path`. A
  `&String`, `&Vec<T>` or `&PathBuf` parameter refuses callers that hold
  the borrowed form and buys nothing.

## Hard rules

- **No inline lint attribute of any kind** — not `#[allow]`, not
  `#[expect]`, not a `cfg_attr` carrying one. Fix the lint, or add a
  visible, commented relaxation to `[lints.clippy]` in `Cargo.toml`.
  There are none today: the exact-decimal design means no float lint
  ever fires, and the two test-only fixtures the sibling crates hold
  quiet with `expect(dead_code)` are `#[cfg(test)]` here instead — an
  item only the tests read is compiled only for the tests. The `policy`
  CI job greps for `#[allow(`; the rule is wider than the grep, because
  a relaxation nobody can see is a relaxation nobody revisits.
- **Clippy pedantic, deny warnings.** `cargo clippy --all-targets --
  -D warnings` must pass.
- **No `anyhow`, no `thiserror`.** Fallible functions return
  `Result<T, String>`.
- **No `clap`.** Arguments are hand-parsed in `cli.rs`, and `FLAGS` is
  held equal to the flags named in `USAGE` by a test.
- **No async runtime.** This tool reads files. There is nothing to
  await.
- **`unsafe` is forbidden crate-wide** (`[lints.rust]`).
- **Dependencies are a cost.** Eight: serde and serde_json, five format
  parsers, and the walker. Every one carries its justification as a
  comment in `Cargo.toml` — a dependency whose reason is not written
  down is one nobody can argue with later. Justify any addition; prefer
  the standard library.
- **No network, ever. Nothing writes. Nothing judges.**
- **Strict parsing, never silent defaults** — for flags. A typo'd
  `--strick` that silently did nothing would report a clean audit that
  never ran the check asked for. The documented exception is `--format`,
  which falls back.
- **Refuse rather than guess**, everywhere: a unit, a locale, a byte
  multiple, a file that could not be read. Never report a resolution you
  did not reach.
- **Refusals speak the caller's vocabulary.** An MCP caller has no
  command line; no message aimed at one mentions a flag. A test asserts
  no MCP output contains `--`.
- **A refusal detail is actionable.** It names the alternatives and what
  to write instead. "Ambiguous" on its own is not a message.

## The corpus contract

`fixtures/` lives inside this crate so the published package is
self-contained — `cargo package` cannot reach above its own directory.
It is not needed to build the binary; it is needed to *verify*: `cargo
test` on the published crate runs every case, so a consumer can check
the claims in the README instead of trusting them.

`fixtures/documents/ambiguous.yaml` is the half that matters. **Every
case in it must come back with a named reason**, and `corpus.rs`
asserts exactly that — one row per line, none dropped, none silently
normalised — plus that `1MB` is the only row in the set that keeps a
base value. A test also asserts that every `Reason` and every
`Dimension` is pinned by some corpus case, so the vocabulary cannot grow
a value nothing checks.

Changing a document or an expectation is a behaviour change and needs a
CHANGELOG entry.

## Testing

- **Do not let a test pass by normalising something that should be
  refused.** That is the exact bug class this tool exists to prevent,
  and it is the one review question that matters here.
- **`extract/` is pure and tests from text.** No temp directories, no
  clocks, no randomness.
- **Exit codes belong in `tests/contracts.rs`.** They are the API —
  callers branch on them — so they are pinned by tests that drive the
  built binary against a temporary tree. A new refusal adds its case
  there.
- **75% line coverage per module in `extract/`**, enforced by the
  `coverage` CI job. Per module rather than on the total: a total hides
  one module sliding while the others carry it. It is a floor and is
  never lowered to make a build pass.
- **Every case in the hardening suites names the bug it would have
  caught.** A case that tests in general is decoration; a case that
  names a defect is a regression test for the whole family.

  | Suite | What it holds | Gate |
  |---|---|---|
  | `tests/hazards.rs` | inputs a real machine holds and a fixture directory cannot — a BOM, invalid UTF-8, a UTF-16 document, a FIFO, permission denied, a symlink loop, a path over 260 characters, several megabytes on one line, an unterminated CSV quote. The tree is built at runtime | none |
  | `tests/platform.rs` | report paths, `TZ` independence, case folding, reserved Windows names, CRLF against LF, early stdin. Three OSes | none |
  | `tests/fuzz.rs` | hostile quantity text through the MCP server: never a panic, never a hang, always a well-formed report, and never an overflow | none — one second on a bare run, `UNITS_LE_FUZZ_SECONDS=60` in CI, **release** there |
  | `tests/budget.rs` | a wall-clock ceiling and linearity in three directions | `UNITS_LE_BUDGET`, **release** |
  | `tests/coverage_matrix.rs` | every extension, format reader, dimension and reason, through the built binary | none |
  | `tests/scenarios.rs` | documents larger than an editor opens | `UNITS_LE_SCENARIOS` |

  **A skipped case is never reported as a pass.** Every gate and every
  platform skip says so by name on stderr. `fuzz` is the one variable
  that is a budget rather than a gate: the net runs on every push and the
  variable only says for how long.

  `fuzz` and `budget` run in **release** on purpose: `overflow-checks` is
  on in that profile, and an out-of-range magnitude must come back as
  `out_of_range` rather than reach the backstop.

  The `coverage_matrix` markers are greped by CI, because `cargo test
  <filter>` exits 0 when the filter matches nothing — a renamed test
  would otherwise pass the job silently. The unit-spelling leg lives in
  `grammar.rs` so it walks `UNITS` and `AMBIGUOUS` themselves rather
  than a list beside them, and checks each symbol against SPEC.md.
- **Every bug fix ships with a regression test** that fails before the
  fix.
- **Run the binary, not only the tests.** The false-positive class in
  the text scan was found by running it over a real repository, not by
  reading the code.

## Verification — the definition of done
- **Commits are conventional and CI enforces it.** The `commits` job in
  `.github/workflows/ci-crate.yml` validates every pushed commit's subject
  against the same pattern as `.githooks/commit-msg`. The hook is opt-in
  per clone (`git config core.hooksPath .githooks`), so `--no-verify` and
  a fresh checkout defer the check to CI rather than escaping it. Scopes
  may be comma-separated.

```bash
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
```

Those three are what the `test` job runs on macOS, Windows and Linux.
Six more jobs run beside it — `hazards` and `platform` on all three
OSes, `fuzz`, `budget`, `coverage-matrix` and `scenarios` on Linux —
plus `msrv`, `policy` (which fails the build on an inline `#[allow]`),
`coverage` and `audit`. Reproduce the gated ones locally:

```bash
UNITS_LE_FUZZ_SECONDS=60 cargo test --locked --release --test fuzz -- --nocapture
UNITS_LE_BUDGET=1 cargo test --locked --release --test budget -- --nocapture
UNITS_LE_SCENARIOS=1 cargo test --locked --test scenarios
cargo llvm-cov            # the 75% per-module floor on extract/
```

A change is not done because it compiles; it is done when it is tested,
linted, documented where behavior changed (README / CHANGELOG / SPEC /
this file), and honest — claims in docs must match the code.

## Commits

The repository root's convention applies unchanged (root `AGENTS.md`):
a conventional prefix, an imperative subject, and a body carrying the
*why* and the user-visible consequence rather than a list of files. One
concern per commit; if a doc describes the thing you changed, it
changes in the same commit. **No AI attribution of any kind** — not a
trailer, not a footer, not a comment.

Every commit uses the GitHub noreply address:

```
13629544+nolindnaidoo@users.noreply.github.com
```

A real address in commit metadata is public forever — GitHub's API
serves it for any public repo, and scrapers harvest it. A repo-local
`user.email` silently overrides the global one, so check
`git config user.email` in a fresh clone before the first commit.

## Not built yet

Written down so nobody assumes otherwise: there is **no VS Code extension
in this repository**. The absent `parity` and `differential` CI jobs
arrive with an extension or not at all.

`release-crate.yml` is in place and unused. It is **dispatch-only and
never triggered by a tag** — a crates.io version can never be reused, so
the irreversible step is one a person chooses on purpose — it refuses a
version already on crates.io, and its preflight runs on a dry run too,
because the point is to find the problem before the publish rather than
halfway through one.
