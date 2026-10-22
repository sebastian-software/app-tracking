# App tracking

App tracking covers release discovery and voluntary usage measurement for
developer tools. A tool, an installation, a project, and a person are different
things.

## Language

**Tool**:
A product whose releases and usage are measured, such as Dalo or Palamedes.
_Avoid_: Project, app instance

**Installation**:
A local tool setup in a user profile. An installation is not necessarily one
person, device, or executable copy.
_Avoid_: User, visitor

**Reporting installation**:
An installation that participates in usage reporting after explicit consent.

**Project**:
A repository used with a tool. Clones and worktrees of the same repository
represent one project; a distinct fork represents a different project.
_Avoid_: Tool, directory name, package name

**Reporting project**:
A project represented in accepted usage reports during a stated period.

**Invocation**:
One execution of the tool's command entry point. A wrapper and the native
binary it launches do not constitute two invocations.

**Usage report**:
A set of locally summarized invocation counts submitted by a reporting
installation.

**Reporting period**:
The interval during which the reported usage occurred, independent of when its
report arrived.

**Update check**:
A request for release information. It does not establish whether a person used
a feature or how many invocations occurred.

**Distribution channel**:
The route through which a tool is installed and updated, such as npm, Cargo,
Homebrew, or a standalone binary.

**Release channel**:
A release selection such as stable or preview within a distribution channel.

**Withdrawal**:
The end of an installation's consent to usage collection and reporting.

**Coverage**:
The known availability and limitations of the observations supporting a
reported metric. Coverage does not establish participation by all tool users.
