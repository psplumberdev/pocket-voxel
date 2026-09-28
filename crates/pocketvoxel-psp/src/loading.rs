//! Present a real frame before synchronous map IO or deferred enemy setup.
use alloc::{string::String, vec::Vec};
use pocketjs_psp::host;
use pocketvoxel_core::{draw::Item, scene::{UiOverlayItem, UiOverlayLabel, UiOverlayRect}, ui};
use pocketvoxel_gu::Renderer;
use psp::sys::{self, GuContextType, GuSyncBehavior, GuSyncMode};

pub unsafe fn present(renderer: &mut Renderer, message: &str) {
    let mut items = Vec::new();
    ui::append_overlay_commands(&[
        UiOverlayItem::Rect(UiOverlayRect { x: 0, y: 0, w: 480, h: 272, abgr: 0xff101010 }),
        UiOverlayItem::Label(UiOverlayLabel { x: 112, y: 116, scale: 2, abgr: 0xffffffff, text: String::from(message) }),
        UiOverlayItem::Label(UiOverlayLabel { x: 174, y: 151, scale: 1, abgr: 0xffb0b0b0, text: String::from("PLEASE WAIT") }),
    ], &mut items);
    let rects: Vec<UiOverlayRect> = items.iter().filter_map(|item| match *item {
        Item::OverlayRect { x, y, w, h, abgr } => Some(UiOverlayRect { x, y, w, h, abgr }),
        _ => None,
    }).collect();
    // Cover both buffers: the pipelined gameplay swap must not reveal the
    // previous map again while the first destination frame is being drawn.
    for _ in 0..2 {
        sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
        renderer.reset_pool();
        sys::sceGuStart(GuContextType::Direct, host::list_ptr());
        renderer.render_debug_overlay(&rects);
        sys::sceKernelDcacheWritebackAll();
        sys::sceGuFinish();
        sys::sceGuSync(GuSyncMode::Finish, GuSyncBehavior::Wait);
        sys::sceDisplayWaitVblankStart();
        sys::sceGuSwapBuffers();
    }
}
