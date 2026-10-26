use super::*;
use serde::Deserialize;
use std::process::Command;

#[derive(Deserialize)]
struct Fixtures {
    normalization_version: u8,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    origin: Option<String>,
    #[serde(default)]
    origin_unavailable: bool,
    package: Option<serde_json::Value>,
    canonical: Option<String>,
    project_id: Option<String>,
}

#[test]
fn normalization_v1_conformance() {
    let fixtures: Fixtures =
        serde_json::from_str(include_str!("../../fixtures/project-identity-v1.json")).unwrap();
    assert_eq!(fixtures.normalization_version, NORMALIZATION_VERSION);
    for case in fixtures.cases {
        let package = case.package.map(|p| p.to_string());
        let origin = if case.origin_unavailable {
            Origin::Unavailable
        } else {
            case.origin.clone().map_or(Origin::Absent, Origin::Present)
        };
        let context = RepositoryContext {
            origin: origin.clone(),
            package_json: package.clone(),
        };
        let result = identify(true, || context);
        assert_eq!(
            result.as_ref().map(|p| p.hash()),
            case.project_id.as_deref(),
            "{}",
            case.name
        );
        if let Some(result) = result {
            assert_eq!(
                result.normalization_version(),
                fixtures.normalization_version
            );
        }
        let canonical = match origin {
            Origin::Present(url) => normalize(&url),
            Origin::Absent => package.as_deref().and_then(package_repository),
            Origin::Unavailable => None,
        };
        assert_eq!(canonical, case.canonical, "{}", case.name);
    }
}

#[test]
fn no_context_discovery_without_collection_permission() {
    assert_eq!(
        identify(false, || panic!("must not discover context")),
        None
    );
}

#[test]
fn diagnostics_do_not_expose_context() {
    let context = RepositoryContext {
        origin: Origin::Present(
            "https://synthetic-user:synthetic-secret@github.com/synthetic/path?secret".into(),
        ),
        package_json: Some(r#"{"repository":"/synthetic/private/path"}"#.into()),
    };
    assert_eq!(
        format!("{context:?}"),
        "RepositoryContext { origin: Present([redacted]), package_json: Some(\"[redacted]\") }"
    );
    assert_eq!(identify(true, || context), None);
    let known = identify(true, || RepositoryContext {
        origin: Origin::Present(
            "https://synthetic-user:synthetic-secret@github.com/example-org/example-project".into(),
        ),
        package_json: None,
    })
    .unwrap();
    let debug = format!("{known:?}");
    for forbidden in [
        "synthetic-user",
        "synthetic-secret",
        "github.com",
        "example-org",
        "example-project",
    ] {
        assert!(!debug.contains(forbidden));
    }
}

#[test]
fn malformed_and_oversized_metadata_is_unknown() {
    for package in ["{", "[]", "null", &" ".repeat(MAX_PACKAGE_BYTES + 1)] {
        assert_eq!(
            identify(true, || RepositoryContext {
                origin: Origin::Absent,
                package_json: Some(package.into()),
            }),
            None
        );
    }
    assert!(
        normalize(&format!(
            "https://github.com/org/{}",
            "x".repeat(MAX_URL_BYTES)
        ))
        .is_none()
    );
}

fn git(directory: &std::path::Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(arguments)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .expect("Git must be available for checkout integration tests");
    assert!(output.status.success(), "synthetic Git fixture failed");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[test]
fn primary_clone_worktree_and_monorepo_have_one_identity() {
    let temp = tempfile::tempdir().unwrap();
    let primary = temp.path().join("primary");
    std::fs::create_dir(&primary).unwrap();
    git(&primary, &["init", "-b", "main"]);
    git(
        &primary,
        &[
            "-c",
            "user.name=Synthetic",
            "-c",
            "user.email=synthetic@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "synthetic fixture",
        ],
    );
    git(
        &primary,
        &[
            "remote",
            "add",
            "origin",
            "git@github.com:example-org/example-project.git",
        ],
    );
    let worktree = temp.path().join("worktree");
    git(
        &primary,
        &[
            "worktree",
            "add",
            "-b",
            "fixture",
            worktree.to_str().unwrap(),
        ],
    );
    let clone = temp.path().join("clone");
    git(
        temp.path(),
        &[
            "clone",
            "--no-local",
            primary.to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    git(
        &clone,
        &[
            "remote",
            "set-url",
            "origin",
            "https://github.com/Example-Org/Example-Project",
        ],
    );
    let nested = worktree.join("packages/one");
    std::fs::create_dir_all(&nested).unwrap();
    let mut results = Vec::new();
    for directory in [&primary, &worktree, &clone, &nested] {
        // Host adapter: Git resolves linked-worktree and nested-directory config.
        // Production library code does not execute Git or inspect directories.
        let origin = git(directory, &["config", "--get", "remote.origin.url"]);
        results.push(
            identify(true, || RepositoryContext {
                origin: Origin::Present(origin),
                package_json: None,
            })
            .unwrap(),
        );
    }
    assert!(results.windows(2).all(|pair| pair[0] == pair[1]));
}
