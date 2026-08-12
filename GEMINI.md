# Contributor and agent instructions

**Read [`crate/AGENTS.md`](crate/AGENTS.md) before writing any code.** This
repository is crate-only — everything that is the product lives in
[`crate/`](crate/) — and that file carries the engineering standard it is held
to: control flow, error handling, structure, the settled decisions and the
definition of done. [`crate/SPEC.md`](crate/SPEC.md) defines the behaviour.
[AGENTS.md](AGENTS.md) at the root routes between them; [CLAUDE.md](CLAUDE.md)
is the short version: gates and traps.

This file exists only to point you there. It is deliberately thin: the standard
lives in one place so it cannot drift between tools.

## Non-negotiables

- **A refusal is a finding.** A quantity that cannot be resolved keeps its row,
  its source text, a named reason and a sentence a person can act on. Never
  normalise something that should be refused; never resolve a refusal to make a
  test pass.
- Guard clauses first. **No statement-position `else`** — two branches are an
  early return, many are a `match`.
- Nesting stops at two levels inside a function; extract a named helper.
- **Base values are exact decimals, never `f64`.** Every conversion is a
  checked integer multiply, and an overflow is `out_of_range` rather than a
  wrap.
- `extract/` is pure and touches no filesystem; only `walk.rs` and `scan.rs`
  may. A `std::fs` call in `extract/` is a bug.
- **No inline `#[allow(...)]`.** Fix the lint, or relax it visibly in
  `[lints.clippy]` in `crate/Cargo.toml`.
- No `anyhow`, no `thiserror`, no `clap`, no async runtime, no regex engine.
  Fallible functions return `Result<T, String>`.
- **Never report success you did not achieve**, and never a resolution you did
  not reach.
- Comments explain **why**, never what.
- Commits are conventional (`fix:`, `feat:`, `docs:`…), imperative, and carry
  no AI attribution of any kind.

## Before you commit

```bash
cd crate
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
```

Coverage is a floor — 90% per module on `crate/src/extract/` — and is never
lowered to make a build pass. Every claim in a README, a help text or SPEC.md
must be provable against the code.
