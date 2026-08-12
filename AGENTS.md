# AGENTS.md — units-le

## What this is

**This repository is crate-only.** Everything that is the product lives
in [`crate/`](crate/): the Rust CLI, the MCP server, the grammar, the
corpus and the tests. There is no VS Code extension beside it, no `src/`
at the root, and no npm package — so unlike the two-frontend siblings in
this family there is no parity contract to keep and nothing here holds
two implementations equal.

That makes this file a router rather than a standard of its own:

| Question | File |
|---|---|
| How should this code be written? | [`crate/AGENTS.md`](crate/AGENTS.md) — the engineering standard, the layout, the settled decisions, the testing requirements, the definition of done |
| What is this tool supposed to do? | [`crate/SPEC.md`](crate/SPEC.md) — the refusal table, the four dimensions, the output contract, the exit codes, the non-goals |
| What does a user see? | [README.md](README.md) |
| What changed? | [CHANGELOG.md](CHANGELOG.md) at the root for the repository, [`crate/CHANGELOG.md`](crate/CHANGELOG.md) for the published crate |

**`crate/AGENTS.md` wins on any conflict.** It is the source of truth
for anything inside `crate/`, which is everything that runs.

## Gates

```bash
cd crate
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
```

All three, exactly as CI runs them. A change is not done because it
compiles; it is done when it is tested, linted, documented where
behaviour changed, and honest — every claim in a README, a help text or
a spec must match the code.

## Things that will bite you

- **A refusal is a finding, and that is the whole product.** Do not let
  a test pass by normalising something that should be refused, and do
  not "fix" a refusal by resolving it. Changing a case means changing
  SPEC.md's refusal table and the corpus in the same commit.
- **`si_iec_hazard` keeps its base value.** It is the one reason that
  annotates rather than withholds. Making it a refusal is a behaviour
  change, not a tidy-up, and `crate/src/extract/corpus.rs` asserts it.
- **Base values never go through an `f64`**, and a `checked_mul` is
  never replaced by a bare `*`. An overflow is `out_of_range`, not a
  wrap; `overflow-checks` in the release profile is the backstop behind
  that check rather than instead of it.
- **Case is part of a unit symbol.** `MB` is bytes and `Mb` is refused.
  No case folding, ever.
- **A bare number is not a finding.** That is numbers-le's question, and
  the boundary is what keeps the two tools distinct.
- **Never add an inline lint attribute** — not `#[allow]`, not
  `#[expect]`, not a `cfg_attr` carrying one. The `policy` CI job greps
  for `#[allow(` and fails the build, and the rule is wider than the
  grep. Fix the lint, add a commented relaxation to `[lints.clippy]` in
  `crate/Cargo.toml`, or make the item `#[cfg(test)]` where only the
  tests read it. There are none today.
- **Coverage is a floor, enforced per module** on `crate/src/extract/`
  at 90%, and never lowered to make a build pass. Per module rather than
  on the total, because a total hides one module sliding while the
  others carry it.
- **The four hardening suites each name the bug they catch.** `hazards`,
  `platform`, `fuzz` and `budget` exist because something real got
  through a green suite somewhere in this family; a new case there
  carries the defect it would have caught, in a comment, or it is
  decoration.
- **Nothing here is byte-identical with the rest of the family, and
  that is deliberate.** The siblings' shared `ci.yml`, dotfiles and
  agent-rules files describe a repository with a VS Code extension at
  its root. This one is crate-only, so every workflow (`ci-crate.yml`,
  `release-crate.yml`, a CodeQL job scanning `rust`), every dotfile and
  every agent-rules file is this repository's own. Copying one across
  from a sibling re-imposes a shape this repo does not have.
- **Run the binary, not only the tests.** The text scan's
  false-positive class was found by running it over a real repository,
  and it is now measured rather than assumed: see
  `crate/fixtures/documents/opaque.txt`.

## Git and commits

Conventional, imperative, subject under 72 characters, scoped to the
files the change touches. No AI attribution of any kind — not a
trailer, not a footer, not a comment. Commits are the author's alone.

## Release

The crate publishes from `crate/` by **dispatching
`release-crate.yml`**, never by pushing a tag: a crates.io version can
never be reused, so the irreversible step is one a person chooses on
purpose, and the workflow refuses a version the registry already
carries. It is **not on crates.io yet**; `crate/CHANGELOG.md` and
`crate/Cargo.toml` are the version's source of truth when it is.
