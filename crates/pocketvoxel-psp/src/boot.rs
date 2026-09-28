//! Small, synchronous startup breadcrumbs that survive a hardware crash.
//! Formatting uses the stack, so diagnostics do not need a healthy heap.
use core::{ffi::c_void, fmt::{self, Write}};
use pocketjs_psp::{arena, qjs_alloc};
use psp::sys::{self, IoOpenFlags};

// The PSP's current directory is launcher-dependent (XMB, PSPLINK, and
// some shell loaders each choose a different one). Keep diagnostics beside
// the EBOOT so a startup failure can always be retrieved from the Memory
// Stick instead of silently writing to an unknown directory.
const PATH: &[u8] = b"ms0:/PSP/GAME/VOXELMON/voxel-boot.log\0";

struct Line { bytes: [u8; 512], len: usize }
impl Write for Line {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        let n = text.len().min(self.bytes.len() - self.len);
        self.bytes[self.len..self.len + n].copy_from_slice(&text.as_bytes()[..n]);
        self.len += n;
        Ok(())
    }
}

unsafe fn write_bytes(bytes: &[u8], truncate: bool) {
    let mode = if truncate { IoOpenFlags::TRUNC } else { IoOpenFlags::APPEND };
    let fd = sys::sceIoOpen(PATH.as_ptr(), IoOpenFlags::CREAT | IoOpenFlags::WR_ONLY | mode, 0o666);
    if fd.0 < 0 { return; }
    let mut written = 0;
    while written < bytes.len() {
        let n = sys::sceIoWrite(fd, bytes[written..].as_ptr() as *const c_void, bytes.len() - written);
        if n <= 0 { break; }
        written += n as usize;
    }
    sys::sceIoClose(fd);
}

pub unsafe fn begin() {
    write_bytes(b"VOXELMON startup diagnostics v1\n", true);
    checkpoint("module entered");
}

pub unsafe fn line(text: &str) {
    let mut out = Line { bytes: [0; 512], len: 0 };
    let _ = writeln!(out, "{}", text);
    write_bytes(&out.bytes[..out.len], false);
}

pub unsafe fn checkpoint(stage: &str) {
    let heap = qjs_alloc::stats();
    let backing = arena::stats();
    let (free, largest) = arena::debug_free();
    let mut out = Line { bytes: [0; 512], len: 0 };
    let _ = writeln!(out,
        "{} | kernel_largest={} arena={} free={} largest={} qjs_live={} peak={} failed={}",
        stage, sys::sceKernelMaxFreeMemSize(), backing.capacity_bytes,
        free, largest, heap.live_requested, heap.peak_requested, heap.last_failed_request);
    write_bytes(&out.bytes[..out.len], false);
}

pub unsafe fn halt(message: &str) -> ! {
    line(message);
    checkpoint("HALT");
    pocketjs_psp::host::halt(message)
}
