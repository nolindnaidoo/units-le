# Instructions for AI coding assistants

Read [AGENTS.md](AGENTS.md) first — it is the engineering-standards
document for this crate and the source of truth for layout, control-flow
style, the settled decisions, testing requirements, and the definition
of done. [SPEC.md](SPEC.md) defines the product behavior. AGENTS.md wins
on any conflict.

- Before declaring any change complete, run all three:
  `cargo fmt --all --check`,
  `cargo clippy --all-targets -- -D warnings`,
  `cargo test --locked`.
- Never add an inline lint attribute — `#[allow]`, `#[expect]`, or a
  `cfg_attr` carrying one. Fix the lint, add a commented relaxation to
  `[lints.clippy]` in `Cargo.toml`, or make the item `#[cfg(test)]` if
  only the tests read it. There are none today.
- **A refusal is a finding, and this is the whole product.** Do not let
  a test pass by normalising something that should be refused, and do
  not "fix" a refusal by resolving it. If a case should change, change
  SPEC.md's refusal table and the corpus in the same commit.
- **`si_iec_hazard` keeps its base value.** It is the one reason that
  annotates rather than withholds, and `corpus.rs` asserts it. Making it
  a refusal is a behaviour change, not a tidy-up.
- **Base values are exact decimals.** Never reach for `f64`, and never
  replace a `checked_mul` with a bare `*` — an overflow is
  `out_of_range`, not a wrap. `overflow-checks` in release is the
  backstop behind that check, not instead of it.
- New logic goes in `extract/` when it is pure, and in `walk.rs` /
  `scan.rs` only when it needs the filesystem. A `std::fs` call in
  `extract/` is a bug.
- **Case is part of a unit symbol.** `MB` is bytes and `Mb` is refused.
  Do not add case folding.
- **A bare number is not a finding.** Do not "improve" the tool by
  extracting one — that is numbers-le's question, and the boundary is
  what keeps the two tools distinct.
- `fixtures/documents/ambiguous.yaml` is one case per line and every
  line must come back with a reason. Adding a line means adding its row
  to `fixtures/extraction.json`.
- Write regression tests for every bug you fix; keep unit tests free of
  clocks, randomness, and the filesystem outside `walk`/`scan`.
- **Run the binary, not only the tests.** The text scan's
  false-positive class was found by running it over a real repository.
