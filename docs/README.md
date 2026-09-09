# dshell documents

Read in order when onboarding; jump straight to a specific doc when
making a targeted change.

| Doc | Read when |
|---|---|
| [`dshell-design.md`](./dshell-design.md) | Starting from the goal, the non-goals, and the six design decisions |
| [`dshell-architecture.md`](./dshell-architecture.md) | Writing or reviewing code: wire protocol, Cordis surface, package layout |
| [`dshell-roadmap.md`](./dshell-roadmap.md) | Picking the next phase to implement |
| [`dshell-packages.md`](./dshell-packages.md) | Looking up which plugin owns a feature |

## Document roles

- `dshell-design.md` is normative for *decisions*. Code that contradicts
  any of its six decisions is wrong.
- `dshell-architecture.md` is normative for *shapes*. Wire frame types,
  Cordis keys, file layout, and CSS conventions are locked there.
- `dshell-roadmap.md` is the sequence of phases. Each phase ends with
  an acceptance check.
- `dshell-packages.md` is the plugin inventory, keyed by the dsh
  service each plugin depends on and the phase that introduces it.

## Source of truth for dsh

All dsh references in this repo resolve to the local checkout under
`dsh/` (untracked; see the repo-root `.gitignore`). When citing dsh
sources, prefer the package README over deep source files; the
READMEs are where dsh's contract is stated.

## How to update these documents

1. Editing a decision: update `dshell-design.md` first, then
   `dshell-architecture.md` if a shape changed, then
   `dshell-roadmap.md` if the phase plan moved, then
   `dshell-packages.md` if a plugin gained or lost responsibility.
2. Adding a new plugin: edit `dshell-packages.md` first, then
   `dshell-roadmap.md` to record the phase that brings it in, then
   `dshell-architecture.md` if it introduces a new Cordis key or wire
   shape.
3. Renaming or removing anything: search all four docs for the old
   name and update in the same commit.