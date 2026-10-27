//! Minimal safe boundary around Windows process creation with no inherited
//! handles. Stdio::null alone does not stop stable std::process::Command from
//! inheriting other pipe/file handles, keeping callers' captured output open.
//! No shell, external helper, raw handle, or caller-provided command is exposed.

use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::ptr::null;
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CreateProcessW, DETACHED_PROCESS, PROCESS_INFORMATION, STARTUPINFOW,
};

pub(super) fn spawn(nonce: &str, argument: &str) -> io::Result<()> {
    if nonce.len() != 64
        || !nonce.bytes().all(|b| b.is_ascii_hexdigit())
        || !matches!(
            argument,
            "--app-tracking-worker-v1" | "--app-tracking-events-worker-v1"
        )
    {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let executable = std::env::current_exe()?;
    // Windows file names cannot contain quotes. With an absolute application
    // path and only fixed ASCII/hex arguments, CRT argv parsing is unambiguous.
    let mut command = OsString::from("\"");
    command.push(&executable);
    command.push("\" ");
    command.push(argument);
    command.push(" ");
    command.push(nonce);
    let application: Vec<u16> = executable
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut command: Vec<u16> = command.encode_wide().chain(Some(0)).collect();
    let startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut process = PROCESS_INFORMATION::default();
    // SAFETY: Both UTF-16 buffers are NUL-terminated and live through this
    // synchronous call; only the command buffer is writable. startup/process
    // are initialized ABI structs with the documented size. Null security,
    // environment and directory pointers select documented inherited defaults.
    // bInheritHandles is FALSE, so no pipe, file, token, or state-lock handle can
    // escape into the child. DETACHED_PROCESS supplies no console/std handles;
    // the worker never reads or writes command streams. Windows retains no
    // pointers to our buffers after CreateProcessW returns.
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
            null(),
            null(),
            &startup,
            &mut process,
        )
    };
    if created == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: A successful CreateProcessW transfers exactly these two owned,
    // valid handles to us. They are closed once here and never exposed or used
    // afterward. Closing them does not terminate the independent child. Windows
    // needs no POSIX-style wait/reaper to release a finished process's resources.
    unsafe {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    Ok(())
}
