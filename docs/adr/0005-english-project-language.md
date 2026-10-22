# ADR 0005: English project language

- Status: Accepted
- Date: 2026-10-22
- Last updated: 2026-10-22

## Context

app-tracking is a public service and client contract shared by multiple tools.
Contributors and consumers need one language for understanding the design,
reviewing changes, and interpreting the API and client behavior.

## Decision

I use US English as the project language. This applies to repository
documentation, ADRs, RFCs, code identifiers and comments, test descriptions,
API documentation and error messages, client-facing copy, commit messages,
issues, and pull requests.

Write directly and explain the action, behavior, and evidence a reader needs.
Use the terms in the [glossary](../../GLOSSARY.md) consistently. Distinguish
reporting installations, projects, and invocations rather than calling all
three users.

Preserve proper names, external identifiers, URLs, and quoted source material
when changing them would alter their meaning. Explain quoted material in
English. Test fixtures may contain other languages when the behavior under
test requires them. This convention does not constrain the language of private
conversations or introduce localization into consuming tools.

## Consequences

- Contributors can read and review one maintained documentation corpus.
- Repository changes must receive an English language check alongside their
  technical review; parallel translations are not required.
- Future localization needs an explicit scope and maintenance decision.

## Change history

- 2026-10-22: Established US English for all project work.
