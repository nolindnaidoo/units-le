# Changelog

All notable changes to Units-LE will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file covers the **VS Code extension**, the npm MCP server and the
npm command line. The Rust CLI in `crate/` keeps its own
[CHANGELOG](crate/CHANGELOG.md). From 1.2.0 every surface carries one
version and releases from one tag. The entries below 1.0.0 describe this
repository while it held the CLI alone.

## [Unreleased]

### Fixed

- The extension's MCP server, the one `units-le-mcp` and the editor run, died
  on an unhandled EPIPE with a Node stack trace when the client closed the
  pipe, which a host logs as the server crashing. It exits 2 quietly at the
  first reply it cannot write, as the crate's server and the npm command
  line do.
- The npm command line's MCP server dropped a frame that was not JSON, not
  UTF-8, not a JSON-RPC 2.0 request or led by a byte order mark without a
  word, where the extension's server answers a parse error; it answered a
  request with a null id, which the extension's server reads as a
  notification; it refused an unknown method, an unknown tool and a call
  naming no tool in its own words; and it held a frame until its newline
  with no ceiling, so a client that streamed without one grew the process
  without bound. It answers every malformed frame in the extension server's
  words now, refuses a frame over 16 MiB and serves the next line, reads a
  last line with no newline as the partial frame it is, joins the chunks of
  a line once at its newline rather than on every chunk, and waits for the
  pipe to drain before reading the next frame.
- The extension's MCP server answered `initialize` with whatever protocol
  version the client asked for and a `listChanged: false` capability, where
  the crate's server answers its own version and `tools: {}`; it replied to
  an `initialize` with no id; it answered `notifications/initialized` sent
  with an id with nothing, where the crate's server refuses an unknown
  method; and a frame led by a byte order mark was read as a request here
  and refused as not JSON there. The three servers answer one handshake and
  one malformed frame alike now. The server also stops reading while the
  pipe to a slow client is full, so what it holds is bounded by the
  requests in flight.
- A number setting cleared to an empty string or null read as 0 and was
  clamped to its floor, so the size guard became 1,000 bytes. It falls back
  to the default.
- A folder or workspace scan counted a file deleted or made unreadable after
  it was listed as "not UTF-8 text". It has its own line in the report:
  "N file(s) could not be read."
- The MCP server held every byte of a frame until its newline, with no
  ceiling, so a client that streamed without one grew the process without
  bound and got no answer. A frame over 16 MiB is refused with a parse error
  and the next line is served.
- A failure inside a command, such as the editor refusing to open a document
  or a dialog going away, escaped as an unhandled rejection the editor
  reported in its own words, home directory included. Every command reports
  it as one redacted, localized error.
- The crate release workflow read a crates.io answer it could not parse, or
  a failed request, as "unpublished" and would have let the publish run. It
  refuses to publish without a version list.

## [1.2.2] - 2026-10-18

### Changed

- **The listing carries the words people search for.** Open VSX ranks a
  match in the name five times a match in the description, and "Units-LE"
  holds "units" but not "unit", which Open VSX does not match to it, so a
  search for "unit" put it 54th on 2026-10-18. The name is "Units-LE: Unit &
  Quantity Extractor", the description opens with "Unit and quantity
  extractor", where a card has room for about forty characters, and the
  keywords are cut from 16 to 11 phrases someone would search for.

## [1.2.1] - 2026-10-17

### Fixed

- **`mcp` no longer ends the session on a frame that is not UTF-8**, in
  the crate or the npm package. Such a frame is dropped like one that is not
  JSON, and the requests after it are served. The npm server reads frames
  with `src/cli/frames.ts`, the crate server's framing in one file shared
  across the family, and `check:cli-pipes` now feeds both servers eighteen
  malformed frames and requests and compares the answers.

## [1.2.0] - 2026-10-17

### Changed

- **One version for every surface.** The extension, the MCP server on
  npm, the new npm command line and the Rust crate all release as 1.2.0
  from the tag `v1.2.0`. The crate jumps from 0.2.3 to join them, and CI
  now fails a commit where any of them disagree.

### Added

- An npm command line, `units-le`, built in `cli/` from `src/cli/`. It is
  the Rust CLI's surface over this extension's extraction engine: the
  same flags, walk, quantities, refusals, exit codes and JSON reports, and
  `units-le mcp` serves the same two tools with the same bytes.
  `scripts/check-cli-parity.ts` runs both binaries over one tree on three
  operating systems and fails on any byte of difference, and
  `scripts/check-cli-pipes.ts` does the same with stdout or stderr closed
  early. It is published as `units-le` on npm, beside `units-le-mcp`.

### Fixed

- The rating prompt's Rate button opened the Marketplace review page for
  every install, including one from Open VSX in VSCodium, Cursor or
  Windsurf, because it told the registries apart by a publisher name the
  Open VSX listing does not carry. It reads the editor's name instead, and
  an Open VSX install rates on Open VSX.

## [1.1.0] - 2026-10-07

### Added

- A rating prompt. On the 3rd successful use, one notification asks whether
  you would rate the extension, with *Rate*, *Later* and *Don't Ask Again*.
  *Rate* opens the registry your copy was installed from: the VS Code
  Marketplace or Open VSX. *Later*, or dismissing it, asks once more on the
  20th use; that second ask is the last. It never appears on activation or
  after a failed run, and it is never shown if you have set
  `notificationsLevel` to `important` or `silent` yourself. The answer
  follows you through Settings Sync. Translated into all 12 locales.
- Scan a folder or the whole workspace. `Units-LE: Scan Workspace for Quantities`
  reads every file in the workspace from disk. `Units-LE: Scan Folder for Quantities`
  does the same for one folder, from the command palette or from a folder in
  the Explorer. Files are read from disk, so an unsaved edit is not seen. The
  report opens with a table of every file that holds a quantity, then has
  a section per file, and ends with a line for each thing the scan left
  unread.
- A scan skips three things by default, each with its own switch:
  dependency folders, build output, caches and lockfiles
  (`units-le.workspace.scanUseDefaultExcludes`), whatever the project's
  `.gitignore` files skip (`units-le.workspace.scanRespectGitignore`), and
  images, fonts, archives and other files that are not text
  (`units-le.workspace.scanSkipBinaryFiles`). `units-le.workspace.scanExcludes`
  skips more, and `units-le.workspace.scanAlwaysInclude` reads a path whatever
  the switches say. The report names which of these were on.
  `units-le.workspace.scanPatterns` chooses the files to read in the first
  place.
- `units-le.workspace.scanMaxFiles` caps how many files are read and
  `units-le.workspace.scanMaxResults` caps how many quantities are listed. A
  file over the safety size, or one that is not UTF-8 text, is left unread,
  and the report says how many were.
- Runs that could not be resolved are counted per file in a scan, not listed.
  `units-le.workspace.scanIncludeRefusals` lists each one, and
  `units-le.workspace.scanProblemsEnabled` also shows them in the Problems
  panel. Both are off by default, so a project's report stays short.
- The positions settings apply to a scan as they do to Extract.
- Positions are now a setting. `units-le.showPositions` decides whether the
  output gives the line and column of each quantity, and
  `units-le.clipboardIncludesPositions` decides the same for the copy on the
  clipboard. Both are on by default, so the output is what it was.

### Changed

- No command is bound to a key by default any more. The one default this
  extension shipped sat on a key the editor, the system or another LE
  extension already used. Every command can still be given a key under
  Keyboard Shortcuts.

## [1.0.1] - 2026-10-04

### Fixed

- The Open VSX links and the Open VSX downloads badge in the README and the
  npm README pointed at a namespace the listing has left, so they led nowhere.
  The listing is under `nolindnaidoo` now, and so are they.

### Removed

- The Zed extension in `zed/`, with the CI job that built it and the workflow
  that synced it. It was never listed in Zed's registry.

## [1.0.0] - 2026-10-04

### Added

- **The VS Code extension.** `Units-LE: Extract Quantities` reports every
  quantity in the active document — as written, in one base unit, with its
  line, column and key path — and every quantity it cannot resolve, with the
  reason. `units-le.dimensions` narrows the report without ever dropping a
  refusal that names no dimension.
- **The MCP server in the VSIX and on npm** as `units-le-mcp`: the same
  `extract_units` tool the Rust CLI serves, answering identically.
- **The engine is a port of the crate's**, with jsonc-parser, saphyr, toml
  (with toml_parser and toml_datetime), rust-ini and csv transcribed, held to
  the crate by the shared corpus, a differential that feeds both servers
  thousands of generated documents in every format — broken ones included,
  so each parser's error text is compared — and a check that both servers
  define the tool identically.
- Localized into twelve languages: the manifest and every runtime string.
- A Zed extension that runs the MCP server as a context server.

## [0.1.1] - 2026-08-14

The crate's own behaviour changes are in
[`crate/CHANGELOG.md`](crate/CHANGELOG.md); this file covers the
repository around it.

### Added

- **A terminal demo** at [`assets/demo.gif`](assets/demo.gif), driving
  the real binary over the files in [`assets/demo/`](assets/demo/).
  [`assets/demo.tape`](assets/demo.tape) is the `vhs` script that
  produced it, so `cd assets && vhs demo.tape` reproduces the recording
  rather than leaving an artifact nobody can regenerate. Both sit above
  `crate/`, where `cargo package` cannot reach them.

### Changed

- **New icon artwork.** All sixteen tools were redrawn in one style, so
  the family reads as one set wherever the cards sit side by side. The
  framing is unchanged — the drawing fills 65.8% of an 800×800 canvas
  and every smaller size is derived from that one file rather than drawn
  again.

### Fixed

- **The README's images resolve away from GitHub.** They were repository
  paths, which crates.io and every other renderer resolves against its
  own origin, so the demo and the icon were broken everywhere this file
  is read that is not this repository. They are absolute URLs now.


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

[0.1.0]: https://crates.io/crates/units-le/0.1.0
[0.1.1]: https://crates.io/crates/units-le/0.1.1
