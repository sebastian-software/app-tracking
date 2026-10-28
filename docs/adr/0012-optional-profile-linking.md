# ADR 0012: Optional shared local profiles

- Status: Accepted
- Date: 2026-10-28
- Last updated: 2026-10-28
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
tools' independently permitted reports. The future Node SDK must prove the
shared file and lifecycle contract before claiming client interoperability.

## Change notes

- 2026-10-28: Select separately permitted, random local profile linking and
  independent reset authority; leave production enrollment disabled.
