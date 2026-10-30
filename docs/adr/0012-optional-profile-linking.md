# ADR 0012: Optional shared local profiles

- Status: Accepted
- Date: 2026-10-28
- Last updated: 2026-10-30
- Activation: Pending released disclosure and review

## Context

Tool-scoped reporting identities cannot measure overlap across products. A
repository hash describes project overlap, which answers a different question.
A shared hardware identity would add unnecessary fingerprinting and still would
not establish a person.

## Decision

Use a separate random local profile, additional affirmative permission per tool,
and independent credentials for tool reporting and shared-profile reset. Start
link eligibility after server acknowledgement, exclude CI, retain the 90-day
detail window, and expose only fixed authenticated whole-period overlap counts.
Keep profiles out of public exports. Implement the lifecycle and default-disabled
activation in the [profile contract](../profile-linking.md).

## Consequences

Copied or lost local files affect profile counts; these never verify people or
physical machines. Tool unlinking, ordinary usage deletion, and shared-profile
reset remain separate controls. Resetting revokes links without erasing other
tools' independently permitted reports. Rust and Node use a new versioned shared file and a non-stealable directory lock.
The legacy Rust file remains independent, with explicit choices and controls for
each format. A crashed lock requires explicit recovery after all tools stop.
This keeps the Node package pure JavaScript without incompatible locks or an
implicit migration of consent.

## Change notes

- 2026-10-28: Select separately permitted, random local profile linking and
  independent reset authority; leave production enrollment disabled.

- 2026-10-30: Select a separate shared v2 format for Rust and pure-JavaScript Node clients; preserve legacy v1 controls and require a fresh choice.
