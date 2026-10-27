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

**Maintainer**:
A person explicitly authorized to inspect private tool usage statistics.
Maintainer access is distinct from an installation's permission to submit reports.

**Invocation**:
One execution of the tool's command entry point. A wrapper and the native
binary it launches do not constitute two invocations.

**Usage report**:
A set of locally summarized invocation counts submitted by a reporting
installation.

**Closed batch**:
An immutable snapshot of summarized usage submitted as one operation. A retry
represents that same operation, not newly observed activity.

**Receipt**:
The retained acknowledgement that a particular batch was accepted. Receiving
a receipt again does not add usage or mean its underlying data is still retained.

**Consent grant**:
An affirmative decision covering a documented reporting purpose and data scope.
A grant is distinct from an update setting or permission to run the tool.

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
A release selection such as stable or preview. Version checks use a shared
release feed across installation methods.

**Release feed**:
Shared release metadata used to choose which version of a tool to advertise,
independent of how the tool was installed.

**Withdrawal**:
The end of an installation's consent to usage collection and reporting.

**Coverage**:
The known availability and limitations of the observations supporting a
reported metric. Coverage does not establish participation by all tool users.
