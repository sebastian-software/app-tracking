//! Shared bounded system categories; the client gates collection.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SystemInfo {
    pub os: String,
    pub os_version: String,
    /// Executable architecture, not a claim about physical hardware (Rosetta).
    pub arch: String,
    pub cpu_family: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linux: Option<LinuxInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LinuxInfo {
    pub distribution: String,
    pub distribution_version: String,
    pub kernel_version: String,
}

pub(super) fn numeric_version(raw: &str) -> String {
    let prefix = raw
        .trim()
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .next()
        .unwrap_or("");
    let parts: Vec<_> = prefix.trim_end_matches('.').split('.').take(4).collect();
    if parts.is_empty() || parts.iter().any(|p| p.is_empty() || p.len() > 5) {
        return "unknown".into();
    }
    parts
        .iter()
        .map(|p| p.parse::<u32>().unwrap_or_default().to_string())
        .collect::<Vec<_>>()
        .join(".")
}

pub(super) fn cpu_family(raw: &str) -> String {
    let raw = raw.trim();
    if let Some(chip) = raw.strip_prefix("Apple M") {
        let mut words = chip.split_whitespace();
        let generation = words.next().unwrap_or("");
        let suffix = words.next();
        if matches!(
            generation,
            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
        ) && matches!(suffix, None | Some("Pro" | "Max" | "Ultra"))
            && words.next().is_none()
        {
            return format!("apple_m{generation}");
        }
    }
    if raw.contains("Intel") || raw == "GenuineIntel" {
        "intel".into()
    } else if raw.contains("AMD") || raw == "AuthenticAMD" {
        "amd".into()
    } else if raw.is_empty() {
        "unknown".into()
    } else {
        "other".into()
    }
}

impl SystemInfo {
    pub fn valid(&self) -> bool {
        matches!(self.os.as_str(), "macos" | "linux" | "windows" | "other")
            && (self.os_version == "unknown"
                || (self.os_version.len() <= 23
                    && numeric_version(&self.os_version) == self.os_version))
            && matches!(
                self.arch.as_str(),
                "aarch64" | "x86_64" | "x86" | "arm" | "other"
            )
            && matches!(
                self.cpu_family.as_str(),
                "apple_m1"
                    | "apple_m2"
                    | "apple_m3"
                    | "apple_m4"
                    | "apple_m5"
                    | "apple_m6"
                    | "apple_m7"
                    | "apple_m8"
                    | "apple_m9"
                    | "intel"
                    | "amd"
                    | "other"
                    | "unknown"
            )
            && self.linux.as_ref().is_none_or(|info| {
                self.os == "linux"
                    && matches!(
                        info.distribution.as_str(),
                        "ubuntu"
                            | "debian"
                            | "fedora"
                            | "arch"
                            | "alpine"
                            | "nixos"
                            | "rhel"
                            | "centos"
                            | "rocky"
                            | "opensuse"
                            | "linuxmint"
                            | "pop"
                            | "other"
                            | "unknown"
                    )
                    && [&info.distribution_version, &info.kernel_version]
                        .into_iter()
                        .all(|v| v == "unknown" || numeric_version(v) == *v)
            })
    }
}

pub(super) fn detect() -> SystemInfo {
    let (version, cpu) = platform();
    #[cfg(target_os = "linux")]
    let linux = linux_context(&version);
    #[cfg(target_os = "linux")]
    let version = linux.distribution_version.clone();
    SystemInfo {
        os: match std::env::consts::OS {
            "macos" => "macos",
            "linux" => "linux",
            "windows" => "windows",
            _ => "other",
        }
        .into(),
        os_version: numeric_version(&version),
        arch: match std::env::consts::ARCH {
            "aarch64" => "aarch64",
            "x86_64" => "x86_64",
            "x86" => "x86",
            "arm" => "arm",
            _ => "other",
        }
        .into(),
        cpu_family: cpu_family(&cpu),
        #[cfg(target_os = "linux")]
        linux: Some(linux),
        #[cfg(not(target_os = "linux"))]
        linux: None,
    }
}

pub(super) fn platform_context() -> SystemInfo {
    SystemInfo {
        os: match std::env::consts::OS {
            "macos" => "macos",
            "linux" => "linux",
            "windows" => "windows",
            _ => "other",
        }
        .into(),
        os_version: "unknown".into(),
        arch: match std::env::consts::ARCH {
            "aarch64" => "aarch64",
            "x86_64" => "x86_64",
            "x86" => "x86",
            "arm" => "arm",
            _ => "other",
        }
        .into(),
        cpu_family: "unknown".into(),
        linux: None,
    }
}

#[cfg(target_os = "macos")]
fn platform() -> (String, String) {
    use sysctl::Sysctl;
    let read = |key| {
        sysctl::Ctl::new(key)
            .and_then(|ctl| ctl.value_string())
            .unwrap_or_default()
    };
    (
        read("kern.osproductversion"),
        read("machdep.cpu.brand_string"),
    )
}
#[cfg(any(target_os = "linux", test))]
fn parse_linux(release: &str, kernel: &str) -> LinuxInfo {
    let field = |name| {
        release
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once('=')?;
                (key == name).then(|| value.trim().trim_matches('"').trim_matches('\'').to_owned())
            })
            .unwrap_or_default()
    };
    let distribution = field("ID");
    LinuxInfo {
        distribution: match distribution.as_str() {
            "ubuntu" | "debian" | "fedora" | "arch" | "alpine" | "nixos" | "rhel" | "centos"
            | "rocky" | "opensuse" | "linuxmint" | "pop" => distribution,
            "" => "unknown".into(),
            _ => "other".into(),
        },
        distribution_version: numeric_version(&field("VERSION_ID")),
        kernel_version: numeric_version(kernel),
    }
}

#[cfg(target_os = "linux")]
fn linux_context(kernel: &str) -> LinuxInfo {
    use std::io::Read;
    let read = |path| {
        let mut value = String::new();
        if let Ok(file) = std::fs::File::open(path) {
            let _ = file.take(16384).read_to_string(&mut value);
        }
        value
    };
    parse_linux(&read("/etc/os-release"), kernel)
}

#[cfg(target_os = "linux")]
fn platform() -> (String, String) {
    use std::io::Read;
    fn read(path: &str, limit: u64) -> String {
        let mut value = String::new();
        if let Ok(file) = std::fs::File::open(path) {
            let _ = file.take(limit).read_to_string(&mut value);
        }
        value
    }
    let cpu = read("/proc/cpuinfo", 16384)
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            matches!(key.trim(), "vendor_id" | "model name").then(|| value.trim().to_owned())
        })
        .unwrap_or_default();
    (read("/proc/sys/kernel/osrelease", 256), cpu)
}
#[cfg(windows)]
fn platform() -> (String, String) {
    use winreg::{
        HKLM,
        enums::{KEY_READ, KEY_WOW64_64KEY},
    };
    let version = HKLM
        .open_subkey_with_flags(
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
            KEY_READ | KEY_WOW64_64KEY,
        )
        .ok()
        .and_then(|key| {
            let major: u32 = key.get_value("CurrentMajorVersionNumber").ok()?;
            let minor: u32 = key.get_value("CurrentMinorVersionNumber").ok()?;
            let build: String = key.get_value("CurrentBuildNumber").ok()?;
            Some(format!("{major}.{minor}.{build}"))
        })
        .unwrap_or_default();
    let cpu = HKLM
        .open_subkey_with_flags(
            r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
            KEY_READ | KEY_WOW64_64KEY,
        )
        .ok()
        .and_then(|key| key.get_value::<String, _>("ProcessorNameString").ok())
        .unwrap_or_default();
    (version, cpu)
}
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn platform() -> (String, String) {
    (String::new(), String::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linux_distribution_is_separate_from_kernel_and_has_no_private_names() {
        let info = parse_linux(
            "ID=ubuntu\nVERSION_ID=\"24.04\"\nPRETTY_NAME=private-host",
            "6.12.3-private-host",
        );
        assert_eq!(info.distribution, "ubuntu");
        assert_eq!(info.distribution_version, "24.4");
        assert_eq!(info.kernel_version, "6.12.3");
        assert_eq!(parse_linux("ID=private-distro", "").distribution, "other");
    }
    #[test]
    fn system_values_are_categories_not_raw_identifiers() {
        assert_eq!(numeric_version("6.12.3-private-host-build"), "6.12.3");
        assert_eq!(numeric_version("private-host"), "unknown");
        assert_eq!(numeric_version("00026.01"), "26.1");
        assert_eq!(cpu_family("Apple M1 Ultra"), "apple_m1");
        assert_eq!(cpu_family("Apple M4 Max"), "apple_m4");
        assert_eq!(cpu_family("Apple M4 private-serial"), "other");
        assert_eq!(cpu_family("Intel(R) Core(TM) i7"), "intel");
        assert_eq!(cpu_family("AMD Ryzen 9"), "amd");
        assert_eq!(cpu_family(""), "unknown");
    }
}
