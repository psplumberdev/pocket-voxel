//! Exercise the same pinned QuickJS parser used by PSP startup, including
//! ownership after the native transport buffer has been released.
use libquickjs_sys::*;
use std::ffi::c_char;

extern "C" {
    fn JS_ParseJSON(ctx: *mut JSContext, buf: *const c_char, len: usize,
        filename: *const c_char) -> JSValue;
    fn JS_NewStringLen(ctx: *mut JSContext, buf: *const u8, len: usize) -> JSValue;
    fn JS_ToBool(ctx: *mut JSContext, value: JSValue) -> i32;
}

unsafe fn check(json: &[u8], valid: bool) {
    let rt = JS_NewRuntime();
    assert!(!rt.is_null());
    let ctx = JS_NewContext(rt);
    assert!(!ctx.is_null());
    let mut transport = json.to_vec();
    transport.push(0);
    let value = JS_ParseJSON(ctx, transport.as_ptr().cast(), json.len(), b"GAME\0".as_ptr().cast());
    drop(transport);
    assert_eq!(!JS_IsException(value), valid);
    if valid {
        let code = b"(a,b) => JSON.stringify(a) === JSON.stringify(JSON.parse(b))\0";
        let compare = JS_Eval(ctx, code.as_ptr().cast(), code.len() - 1,
            b"test\0".as_ptr().cast(), JS_EVAL_TYPE_GLOBAL as i32);
        assert!(!JS_IsException(compare));
        let text = JS_NewStringLen(ctx, json.as_ptr(), json.len());
        let mut args = [value, text];
        let result = JS_Call(ctx, compare, JS_UNDEFINED, 2, args.as_mut_ptr());
        assert!(!JS_IsException(result));
        assert_eq!(JS_ToBool(ctx, result), 1);
        JS_FreeValue(ctx, result);
        JS_FreeValue(ctx, text);
        JS_FreeValue(ctx, compare);
    } else {
        let exception = JS_GetException(ctx);
        JS_FreeValue(ctx, exception);
    }
    JS_FreeValue(ctx, value);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

#[test]
fn native_json_matches_guest_parser_and_owns_strings() {
    unsafe { check("{\"name\":\"Pokémon ♀\",\"text\":\"\\u0000\\ue001\",\"nested\":[null,true,-2.5,{\"hp\":42}]}".as_bytes(), true); }
}

#[test]
fn native_json_propagates_invalid_input_as_exception() {
    unsafe { check(b"{\"broken\":", false); }
}

#[test]
fn cooked_game_matches_guest_parser_when_available() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../dist/voxelmon/gamedata.json");
    let Ok(json) = std::fs::read(path) else { eprintln!("SKIP: no local cooked GAME"); return; };
    unsafe { check(&json, true); }
}
