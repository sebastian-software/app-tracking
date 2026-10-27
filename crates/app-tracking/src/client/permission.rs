use super::{Client, Collection, Error, State, Store, SystemContext};
use serde::Serialize;
use std::io::{BufRead, IsTerminal, Read, Write};

/// Whether an explicit permission request may open a terminal dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interaction {
    /// Ask only when stdin and stderr are terminals, outside CI and workers.
    Terminal,
    /// Use for JSON output, editor integrations, and other unattended contexts.
    Never,
}

/// The saved decision, independent of temporary process restrictions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OptInDecision {
    Undecided,
    Granted,
    Declined,
}

impl From<Option<bool>> for OptInDecision {
    fn from(value: Option<bool>) -> Self {
        match value {
            None => Self::Undecided,
            Some(true) => Self::Granted,
            Some(false) => Self::Declined,
        }
    }
}

/// An effective answer to an explicit permission request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionOutcome {
    Granted,
    Declined,
    /// No eligible saved answer and no dialog, or the dialog ended without one.
    Unavailable,
}

impl Client {
    /// Disable dialogs for machine-readable or unattended host modes. Saved
    /// decisions still apply. This does not change collection policy.
    pub fn with_interaction(mut self, interaction: Interaction) -> Self {
        self.interaction = interaction;
        self
    }

    /// Explain the tool's purpose, ask yes/no, and persist the answer once.
    ///
    /// Reuses both saved grants and refusals without asking again. Only this
    /// explicit method can display a dialog; `record` and `download` never ask.
    /// No dialog opens in CI, a worker, or without terminal stdin and stderr.
    /// An empty submitted answer declines; EOF leaves the decision unchanged.
    /// Use `Interaction::Never` for tool-specific JSON/agent output modes.
    pub fn request_opt_in(&self, message: &str) -> Result<PermissionOutcome, Error> {
        let interactive = self.interaction == Interaction::Terminal
            && !self.policy.ci
            && std::io::stdin().is_terminal()
            && std::io::stderr().is_terminal();
        self.request_with(message, interactive, |prompt| {
            ask(
                &mut std::io::stdin().lock(),
                &mut std::io::stderr().lock(),
                prompt,
            )
        })
    }

    pub(super) fn is_background_worker(&self) -> bool {
        std::env::args().nth(1).is_some_and(|argument| {
            argument == super::BACKGROUND_WORKER_ARGUMENT
                || argument == crate::telemetry::BACKGROUND_WORKER_ARGUMENT
        })
    }

    fn permission(&self, state: &State) -> Option<PermissionOutcome> {
        if state.disabled || state.deleting {
            return Some(PermissionOutcome::Unavailable);
        }
        match state.opt_in {
            Some(false) => Some(PermissionOutcome::Declined),
            Some(true) if state.opt_in_scope.as_ref() != Some(&self.opt_in_scope) => None,
            Some(true) => Some(if self.allowed(state, Collection::OptIn) {
                PermissionOutcome::Granted
            } else {
                PermissionOutcome::Unavailable
            }),
            None => None,
        }
    }

    fn request_with(
        &self,
        message: &str,
        interactive: bool,
        answer: impl FnOnce(&str) -> Result<Option<bool>, Error>,
    ) -> Result<PermissionOutcome, Error> {
        if message.trim().is_empty()
            || message.len() > 4096
            || message
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err(Error::Configuration);
        }
        if self.veto()
            || self.is_background_worker()
            || !self
                .metrics
                .values()
                .any(|m| m.collection == Collection::OptIn)
        {
            return Ok(PermissionOutcome::Unavailable);
        }
        let generation = {
            let store = Store::open(self, false)?;
            if let Some(store) = &store
                && let Some(outcome) = self.permission(&store.state)
            {
                return Ok(outcome);
            }
            store.map_or(0, |s| s.state.generation)
        }; // Never keep a state or network lock while waiting for a person.
        if !interactive || self.interaction == Interaction::Never || self.policy.ci {
            return Ok(PermissionOutcome::Unavailable);
        }
        let Some(enabled) = answer(&self.permission_message(message))? else {
            return Ok(PermissionOutcome::Unavailable);
        };
        let mut store = Store::open(self, true)?.ok_or(Error::State)?;
        let _network = store.network_guard()?;
        // A concurrent settings change wins over an earlier open dialog.
        if let Some(outcome) = self.permission(&store.state) {
            return Ok(outcome);
        }
        if store.state.generation != generation {
            return Ok(PermissionOutcome::Unavailable);
        }
        self.save_choice(&mut store, enabled)?;
        Ok(if enabled {
            PermissionOutcome::Granted
        } else {
            PermissionOutcome::Declined
        })
    }

    fn permission_message(&self, reason: &str) -> String {
        let metrics: Vec<_> = self
            .metrics
            .values()
            .filter(|m| m.collection == Collection::OptIn)
            .collect();
        let mut text = format!(
            "\nOptional usage reporting for {}\n\n{}\n\n",
            self.tool,
            reason.trim()
        );
        text.push_str(
            "Data: usage counts, tool version, and a random reporting ID for this tool/profile.\n",
        );
        for metric in &metrics {
            text.push_str(&format!("  {}", metric.id));
            if !metric.dimensions.is_empty() {
                text.push_str(" (categories: ");
                text.push_str(
                    &metric
                        .dimensions
                        .keys()
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", "),
                );
                text.push(')');
            }
            text.push('\n');
        }
        if metrics.iter().any(|m| m.system == SystemContext::Full) {
            text.push_str(
                "Also: OS family/version, executable architecture, and CPU family/generation.\n",
            );
        } else if metrics.iter().any(|m| m.system == SystemContext::Platform) {
            text.push_str("Also: OS family and executable architecture.\n");
        }
        if metrics.iter().any(|m| m.project) {
            text.push_str("Also: SHA-256 of the normalized repository URL, when available.\n");
        }
        text.push_str("Your answer is saved for this tool/profile. You can change it in the tool's settings.\n\nAllow optional usage reporting? [y/N] ");
        text
    }
}

fn ask(
    input: &mut impl BufRead,
    output: &mut impl Write,
    prompt: &str,
) -> Result<Option<bool>, Error> {
    output
        .write_all(prompt.as_bytes())
        .map_err(|_| Error::Interaction)?;
    loop {
        output.flush().map_err(|_| Error::Interaction)?;
        let mut line = Vec::new();
        let length = Read::take(&mut *input, 257)
            .read_until(b'\n', &mut line)
            .map_err(|_| Error::Interaction)?;
        if length == 0 {
            return Ok(None);
        }
        if length > 256 {
            return Err(Error::Interaction);
        }
        // An interrupted partial line is not a submitted answer.
        if line.last() != Some(&b'\n') {
            return Ok(None);
        }
        let answer = std::str::from_utf8(&line).map_err(|_| Error::Interaction)?;
        match answer.trim().to_ascii_lowercase().as_str() {
            "y" | "yes" => return Ok(Some(true)),
            "" | "n" | "no" => return Ok(Some(false)),
            _ => output
                .write_all(b"Please answer yes or no. [y/N] ")
                .map_err(|_| Error::Interaction)?,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn terminal_answers_are_explicit_bounded_and_do_not_echo_input() {
        for (input, expected) in [
            ("YES\n", Some(true)),
            (" n \r\n", Some(false)),
            ("\n", Some(false)),
            ("", None),
            ("y", None),
            ("secret\nyes\n", Some(true)),
        ] {
            let mut output = Vec::new();
            assert_eq!(
                ask(&mut Cursor::new(input), &mut output, "prompt ").unwrap(),
                expected
            );
            assert!(!String::from_utf8(output).unwrap().contains("secret"));
        }
        assert!(matches!(
            ask(&mut Cursor::new(vec![b'x'; 257]), &mut Vec::new(), ""),
            Err(Error::Interaction)
        ));
    }

    #[test]
    fn prompt_and_decision_are_owned_by_the_library_and_reused() {
        for enabled in [true, false] {
            let directory = tempfile::tempdir().unwrap();
            let client = super::super::tests::client(directory.path());
            assert_eq!(client.status().unwrap().decision, OptInDecision::Undecided);
            let outcome = client
                .request_with("Help improve this tool.", true, |prompt| {
                    assert!(prompt.contains("Help improve this tool."));
                    assert!(prompt.contains("rich (categories: format)"));
                    assert!(prompt.contains("CPU family/generation"));
                    assert!(!prompt.contains("basic"));
                    assert!(!client.directory.exists());
                    Ok(Some(enabled))
                })
                .unwrap();
            assert_eq!(
                outcome,
                if enabled {
                    PermissionOutcome::Granted
                } else {
                    PermissionOutcome::Declined
                }
            );
            let client = super::super::tests::client(directory.path());
            assert_eq!(
                client
                    .request_with("Purpose", false, |_| panic!("saved answer must not ask"))
                    .unwrap(),
                outcome
            );
            assert_eq!(
                client.status().unwrap().decision,
                if enabled {
                    OptInDecision::Granted
                } else {
                    OptInDecision::Declined
                }
            );
        }
    }

    #[test]
    fn a_saved_grant_does_not_silently_cover_expanded_metric_scope() {
        let directory = tempfile::tempdir().unwrap();
        let original = super::super::tests::client(directory.path());
        original.set_opt_in(true).unwrap();
        original
            .record("rich", super::super::tests::values)
            .unwrap();
        let expanded = Client::new(
            "https://tracking.example",
            directory.path(),
            "fixture",
            "2.1.0",
            [super::super::Metric::counter("extra", Collection::OptIn).unwrap()],
        )
        .unwrap();
        assert!(!expanded.status().unwrap().collect_opt_in);
        assert_eq!(
            expanded
                .record("extra", || panic!("new scope not granted"))
                .unwrap(),
            super::super::Recorded::Suppressed
        );
        assert_eq!(
            expanded
                .request_with("New purpose", false, |_| panic!("unattended"))
                .unwrap(),
            PermissionOutcome::Unavailable
        );
        assert_eq!(
            expanded
                .request_with("New purpose", true, |prompt| {
                    assert!(prompt.contains("extra"));
                    Ok(Some(true))
                })
                .unwrap(),
            PermissionOutcome::Granted
        );
        assert!(expanded.status().unwrap().collect_opt_in);
    }

    #[test]
    fn unavailable_does_not_manufacture_a_refusal_or_create_state() {
        let directory = tempfile::tempdir().unwrap();
        let client = super::super::tests::client(directory.path());
        assert_eq!(
            client
                .request_with("Purpose", false, |_| panic!("no dialog"))
                .unwrap(),
            PermissionOutcome::Unavailable
        );
        assert_eq!(
            client.request_with("Purpose", true, |_| Ok(None)).unwrap(),
            PermissionOutcome::Unavailable
        );
        assert!(!client.directory.exists());
        assert_eq!(client.status().unwrap().decision, OptInDecision::Undecided);
        for message in ["", " \n", "reason\u{1b}[31m"] {
            assert!(matches!(
                client.request_with(message, true, |_| panic!("invalid message")),
                Err(Error::Configuration)
            ));
        }
    }

    #[test]
    fn prompt_holds_no_locks_and_a_concurrent_refusal_wins() {
        let directory = tempfile::tempdir().unwrap();
        let client = super::super::tests::client(directory.path());
        assert_eq!(
            client
                .request_with("Purpose", true, |_| {
                    client.set_opt_in(false)?;
                    Ok(Some(true))
                })
                .unwrap(),
            PermissionOutcome::Declined
        );
        assert!(!client.status().unwrap().opt_in);
    }

    #[test]
    fn machine_modes_and_process_restrictions_never_open_a_dialog() {
        let directory = tempfile::tempdir().unwrap();
        let client =
            super::super::tests::client(directory.path()).with_interaction(Interaction::Never);
        assert_eq!(
            client
                .request_with("Purpose", true, |_| panic!("no dialog"))
                .unwrap(),
            PermissionOutcome::Unavailable
        );
        client.set_opt_in(true).unwrap();
        assert_eq!(
            client.request_opt_in("Purpose").unwrap(),
            PermissionOutcome::Granted
        );
        let client = client.with_policy(crate::telemetry::Policy {
            do_not_track: true,
            ..Default::default()
        });
        assert_eq!(
            client
                .request_with("Purpose", true, |_| panic!("no dialog"))
                .unwrap(),
            PermissionOutcome::Unavailable
        );
        let directory = tempfile::tempdir().unwrap();
        let client =
            super::super::tests::client(directory.path()).with_policy(crate::telemetry::Policy {
                ci: true,
                ..Default::default()
            });
        assert_eq!(
            client
                .request_with("Purpose", true, |_| panic!("no dialog"))
                .unwrap(),
            PermissionOutcome::Unavailable
        );
    }
}

#[cfg(test)]
mod expiry_tests {
    use super::*;
    #[test]
    fn active_grants_do_not_expire_on_a_calendar_schedule() {
        let directory = tempfile::tempdir().unwrap();
        let client = super::super::tests::client(directory.path());
        client.set_opt_in(true).unwrap();
        {
            let mut store = Store::open(&client, false).unwrap().unwrap();
            let identity = store.state.identity.as_mut().unwrap();
            identity.consented_at = super::super::now().unwrap() - 91 * 86_400_000;
            identity.last_accepted_at = super::super::now().unwrap();
            store.save().unwrap();
        }
        assert_eq!(
            client.request_opt_in("Purpose").unwrap(),
            PermissionOutcome::Granted
        );
        {
            let mut store = Store::open(&client, false).unwrap().unwrap();
            let identity = store.state.identity.as_mut().unwrap();
            identity.last_accepted_at = identity.consented_at;
            store.save().unwrap();
        }
        assert_eq!(
            client
                .request_with("Purpose", true, |_| panic!("must not silently renew"))
                .unwrap(),
            PermissionOutcome::Unavailable
        );
        assert!(matches!(
            client.set_opt_in(true),
            Err(Error::PreviousIdentity)
        ));
    }
}
