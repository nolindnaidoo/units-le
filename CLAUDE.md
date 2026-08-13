# CLAUDE.md

[AGENTS.md](AGENTS.md) is the technical source of truth for this repo. It is a
router: **this repository is crate-only**, so everything that is the product
lives in [`crate/`](crate/) and [`crate/AGENTS.md`](crate/AGENTS.md) is the
engineering standard the code is held to — control flow, error handling,
structure, the settled decisions, the definition of done. Read it before
writing code. [`crate/SPEC.md`](crate/SPEC.md) defines the product behaviour.

## Where to look

| Question | File |
|---|---|
| How should this code be written? | [`crate/AGENTS.md`](crate/AGENTS.md) — the standard, the architecture, the invariants |
| What is the tool supposed to do? | [`crate/SPEC.md`](crate/SPEC.md) — refusals, dimensions, exit codes, non-goals |
| What does the user see? | [README.md](README.md) |
| What changed? | [CHANGELOG.md](CHANGELOG.md) · [`crate/CHANGELOG.md`](crate/CHANGELOG.md) |

## Gates

```bash
cd crate && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test --locked
```

All three, exactly as CI runs them. The gated suites are extra:
`UNITS_LE_BUDGET=1 cargo test --release --test budget`,
`UNITS_LE_FUZZ_SECONDS=60 cargo test --release --test fuzz`,
`UNITS_LE_SCENARIOS=1 cargo test --test scenarios`.

## Things that will bite you

- **A refusal is a finding — that is the product, not a feature of it.** Never
  let a test pass by normalising something that should be refused, and never
  "fix" a refusal by resolving it. A changed case means a changed refusal table
  in SPEC.md and a changed corpus, in the same commit.
- **`si_iec_hazard` keeps its base value.** The one reason that annotates
  rather than withholds. Making it a refusal is a behaviour change.
- **Never reach for `f64`, never replace a `checked_mul` with a bare `*`.** An
  overflow is `out_of_range`, not a wrap.
- **Case is part of a unit symbol** (`MB` is bytes, `Mb` is refused), and **a
  bare number is not a finding** — that is numbers-le's question.
- **No inline lint attribute** — `#[allow]`, `#[expect]` or a `cfg_attr`
  carrying one. The `policy` CI job greps for `#[allow(`, and the rule is wider
  than the grep. Fix the lint, relax it visibly in `[lints.clippy]`, or make
  the item `#[cfg(test)]` if only the tests read it.
- **Every claim must be provable.** No metric, format or behaviour goes in a
  README, a help text or SPEC.md unless the code backs it — and the numbers in
  the README's Testing section come from a real `cargo llvm-cov` run. That
  governs **behaviour and numbers**, not **availability**: an install line for
  a publish you are about to make is **staged, not forbidden**. Write it, and
  let the release commit be what makes it true.
- **Nothing here is byte-identical with the rest of the family.** The siblings'
  `ci.yml`, dotfiles and agent-rules files describe a repository with a VS Code
  extension at its root; this one is crate-only, so its workflows
  (`ci-crate.yml`, `release-crate.yml`, a CodeQL job scanning `rust`), its
  dotfiles and its agent-rules files are its own. Copying one over from a
  sibling re-imposes a shape this repo does not have.
- **CI narrows itself on a docs-only push.** `ci-crate.yml` fires on `*.md` and
  the agent instruction files — it has to, because the `policy` job greps them,
  and the filter used to admit only `crate/**` so that gate could run only when
  the files it guards had *not* been touched. On a docs-only push `policy` and
  `commits` run and every Rust job skips. Anything unrecognised, and an
  unreadable diff, counts as code and runs everything.
- **Coverage floors are a backstop, not a target** — per module on `extract/`,
  well below where the code actually is, and never raised to track it.
- **Run the binary, not only the tests.** The text scan's false-positive class
  was found that way, and is now measured by
  `crate/fixtures/documents/opaque.txt`.
