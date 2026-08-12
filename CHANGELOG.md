# Changelog

The units-le repository. The published crate keeps its own history in
[`crate/CHANGELOG.md`](crate/CHANGELOG.md); this file covers the
repository around it.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

0.1.0 has not shipped, so everything below lands in it when it does.
The crate's own behaviour changes are in
[`crate/CHANGELOG.md`](crate/CHANGELOG.md); this file covers the
repository around it.

### Fixed

- **The documentation now describes the repository that exists.** An
  audit against `crate/AGENTS.md` found five claims it had outgrown: a
  release workflow said not to exist (`release-crate.yml` has been in
  place, and it is dispatch-only rather than tag-driven as the root
  document said), a `ci.yml` and a set of "byte-identical" shared
  dotfiles that this crate-only repository does not have and cannot
  have, a dependency count of four format parsers where there are five,
  a fuzz suite described as gated when its variable is a budget, and a
  CI job list missing `scenarios`.
- **The no-inline-`#[allow]` rule is stated as the rule rather than as
  the grep that enforces half of it.** Two `expect(dead_code)`
  attributes had lived in `extract/` since the first commit while every
  document claimed there were none.
- **The measured false-finding rate is rounded rather than truncated**,
  so the number the test prints and the number five documents quote are
  the same 1.8%. The test now fails if SPEC.md or the README quotes a
  different one.

## [0.1.0] - 2026-08-12

First release. A Rust CLI and MCP server that extracts every quantity in
a tree — a number welded to a unit — reports it as the document wrote it
*and* in one base unit, and refuses by name the ones it cannot resolve.

### Added

- **The crate**, in [`crate/`](crate/): the hand-written unit grammar,
  exact decimal arithmetic, six format readers plus a text scan, an
  ignore-aware tree walk, both surfaces, and an embedded corpus that
  pins every answer. Full detail in
  [`crate/CHANGELOG.md`](crate/CHANGELOG.md).

  This repository is **crate-only** — there is no VS Code extension
  beside it, so the `parity` and `differential` jobs the two-frontend
  siblings run are deliberately absent rather than present and vacuous.

- **The four hardening suites**, each naming the defect it would have
  caught rather than testing in general.

  - `tests/hazards.rs` — a byte-order mark, invalid UTF-8, a UTF-16
    document, a named pipe, a permission-denied file, a symlink loop, a
    path over 260 characters, an empty file, several megabytes on one
    line, and a CSV whose quote never closes. The tree is built at
    runtime and a case the platform cannot express is skipped by name.
  - `tests/platform.rs` — report paths, `TZ` independence, case-folding
    filesystems, the reserved Windows filenames, CRLF against LF in all
    six formats, and a child that refuses before it reads stdin.
  - `tests/fuzz.rs` — hostile quantity text against the grammar and the
    exact decimals: enormous digit runs, magnitudes past what a `PiB`
    multiplier fits, chained compounds, every ambiguous symbol in every
    position, decimal separators from several locales, ISO-8601
    durations with absurd component counts, and negative and zero
    quantities. Never a panic, never a hang, always a well-formed
    report, and an out-of-range magnitude always `out_of_range`.
  - `tests/budget.rs` — a wall-clock ceiling on a seeded tree, plus
    linearity in three directions: four times the files, four times the
    quantities in one file, and four times the quantities on one
    non-ASCII line.
  - `tests/coverage_matrix.rs` — every extension the alias table names,
    every format reader, every `Dimension` and every `Reason`, reached
    through the built binary over a real tree.

- **CI**: `hazards` and `platform` on macOS, Windows and Linux; `fuzz`,
  `budget` and `coverage-matrix` on Linux, alongside the existing test,
  MSRV, policy, coverage and audit jobs.

- **Repository documentation**: this file, [README.md](README.md),
  [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), [GEMINI.md](GEMINI.md)
  and [LICENSE](LICENSE).

### Fixed

- **A quadratic column lookup on a long non-ASCII line.** The UTF-16
  column index re-counted from the line start on every lookup. The
  all-ASCII fast path hid it on ordinary source and nothing covered the
  rest, so a minified or generated file — one very long line — cost
  **15.7x** the clock for four times the quantities. `PositionIndex`
  now counts on from its last answer, and `tests/budget.rs` asserts the
  slope. Same shape ips-le found; same fix.

- **Report paths used the platform separator.** A report produced on
  Windows spelled every path with `\` and one produced anywhere else
  with `/`, so the two could not be diffed — which is most of what a
  report in CI is for. Paths in the report are now `/` on every
  platform, and `tests/platform.rs` asserts it. Same defect envsync-le
  shipped for a release.

### Measured

- **The text scan's false-finding rate over opaque content: 1.8%** — 5
  findings over 280 lines of lockfile integrity hashes, container
  digests, git object names, UUIDs, content-addressed asset names and
  signing material, none of which is a quantity.
  `crate/fixtures/documents/opaque.txt` is that corpus, generated once
  from a fixed seed and checked in, and a test prints the rate on every
  run. The behaviour is unchanged and documented in
  [`crate/SPEC.md`](crate/SPEC.md); the number now exists so a change to
  it is visible.

[0.1.0]: https://github.com/nolindnaidoo/units-le/releases/tag/v0.1.0
