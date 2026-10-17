//! hypertoy-wasm: a C-ABI surface over the engine, loaded by both the
//! AudioWorklet (engine_*, toy_*) and the field Worker (gs_*).
//!
//! No wasm-bindgen: its JS glue does not run in AudioWorkletGlobalScope, and a
//! handful of plain numeric exports is all the hosts need. Allocation happens
//! in `engine_new` / `gs_new` and in the load commands (`toy_add`,
//! `toy_load_*`, which run between blocks); `engine_process` never allocates.
//!
//! Load commands read their payload from the engine's scratch buffer
//! (`engine_scratch_ptr`): numbers as f32 words, text as UTF-8 bytes. They
//! return 0, or a negative error code (see `engine::LoadError::code`).

mod builtin;
mod custom;
mod engine;
mod voice;

pub use engine::{Engine, BLOCK, MAX_TOYS, SNAP_HEADER, SNAP_LEN, SNAP_STRIDE};

fn code(r: Result<(), engine::LoadError>) -> i32 {
    r.err().map_or(0, |e| e.code())
}
use hypertoy_laws::gray_scott::Field;

// ---- audio engine ---------------------------------------------------------

#[no_mangle]
pub extern "C" fn engine_new(sample_rate: f32) -> *mut Engine {
    Box::into_raw(Box::new(Engine::new(sample_rate)))
}

/// # Safety
/// `e` must come from `engine_new`. Same for every `engine_*` / `toy_*` export.
#[no_mangle]
pub unsafe extern "C" fn engine_out_ptr(e: *mut Engine) -> *const f32 {
    (*e).out.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn engine_snap_ptr(e: *mut Engine) -> *const f32 {
    (*e).snap.as_ptr()
}

#[no_mangle]
pub extern "C" fn engine_snap_len() -> u32 {
    SNAP_LEN as u32
}

#[no_mangle]
pub unsafe extern "C" fn engine_process(e: *mut Engine, frames: u32) {
    (*e).process(frames as usize)
}

#[no_mangle]
pub unsafe extern "C" fn engine_set_tempo(e: *mut Engine, bpm: f32) {
    (*e).clock.bpm = bpm.clamp(30.0, 240.0) as f64;
}

#[no_mangle]
pub unsafe extern "C" fn engine_set_tuning(e: *mut Engine, root_midi: f32, scale: u32, wild: u32) {
    (*e).set_tuning(root_midi, scale, wild != 0)
}

#[no_mangle]
pub unsafe extern "C" fn engine_set_master(e: *mut Engine, gain: f32) {
    (*e).master = gain.clamp(0.0, 1.0);
}

#[no_mangle]
pub unsafe extern "C" fn toy_add(e: *mut Engine, slot: u32, kind: u32) {
    (*e).add_toy(slot as usize, kind)
}

#[no_mangle]
pub unsafe extern "C" fn toy_remove(e: *mut Engine, slot: u32) {
    (*e).remove_toy(slot as usize)
}

#[no_mangle]
pub unsafe extern "C" fn toy_set_param(e: *mut Engine, slot: u32, param: u32, value: f32) {
    (*e).set_param(slot as usize, param as usize, value)
}

#[no_mangle]
pub unsafe extern "C" fn toy_set_step(e: *mut Engine, slot: u32, step: u32, prob: f32) {
    (*e).set_step(slot as usize, step as usize, prob)
}

#[no_mangle]
pub unsafe extern "C" fn toy_poke(e: *mut Engine, slot: u32, strength: f32, aux: f32) {
    (*e).poke(slot as usize, strength, aux)
}

// ---- scratch, external voices, events --------------------------------------

#[no_mangle]
pub unsafe extern "C" fn engine_scratch_ptr(e: *mut Engine) -> *mut f32 {
    (*e).scratch.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn engine_scratch_len() -> u32 {
    engine::SCRATCH_LEN as u32
}

/// Per slot: BLOCK left samples then BLOCK right, written by the host for external voices.
#[no_mangle]
pub unsafe extern "C" fn engine_ext_ptr(e: *mut Engine) -> *mut f32 {
    (*e).ext.as_mut_ptr()
}

/// Per slot: BLOCK mono samples of the last block (audio inputs for modules).
#[no_mangle]
pub unsafe extern "C" fn engine_bus_ptr(e: *mut Engine) -> *const f32 {
    (*e).bus.as_ptr()
}

/// `[slot, frame, kind, a, b]` records since the last `engine_events_clear`.
#[no_mangle]
pub unsafe extern "C" fn engine_events_ptr(e: *mut Engine) -> *const f32 {
    (*e).events.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn engine_events_len(e: *mut Engine) -> u32 {
    (*e).n_events as u32
}

#[no_mangle]
pub unsafe extern "C" fn engine_events_clear(e: *mut Engine) {
    (*e).clear_events()
}

// ---- load commands (payload in scratch) -----------------------------------

#[no_mangle]
pub unsafe extern "C" fn engine_set_tuning_table(e: *mut Engine, len: u32) -> i32 {
    code((*e).set_tuning_table(len as usize))
}

#[no_mangle]
pub unsafe extern "C" fn engine_set_tuning_scl(e: *mut Engine, len: u32) -> i32 {
    code((*e).set_tuning_scl(len as usize))
}

#[no_mangle]
pub unsafe extern "C" fn toy_set_pattern(e: *mut Engine, slot: u32, len: u32) -> i32 {
    code((*e).set_pattern(slot as usize, len as usize))
}

#[no_mangle]
pub unsafe extern "C" fn toy_set_law(e: *mut Engine, slot: u32, law: u32, wild: u32) -> i32 {
    code((*e).set_law(slot as usize, law, wild != 0))
}

#[no_mangle]
pub unsafe extern "C" fn toy_load_patch(e: *mut Engine, slot: u32, len: u32, voices: u32, gate_s: f32) -> i32 {
    code((*e).load_patch(slot as usize, len as usize, voices as usize, gate_s))
}

#[no_mangle]
pub unsafe extern "C" fn toy_load_zap(e: *mut Engine, slot: u32, len: u32) -> i32 {
    code((*e).load_zap(slot as usize, len as usize))
}

#[no_mangle]
pub unsafe extern "C" fn toy_load_external(e: *mut Engine, slot: u32) -> i32 {
    code((*e).load_external(slot as usize))
}

// ---- reaction-diffusion field --------------------------------------------

#[no_mangle]
pub extern "C" fn gs_new(w: u32, h: u32, seed: u32) -> *mut Field {
    Box::into_raw(Box::new(Field::new(w as usize, h as usize, seed as u64)))
}

/// # Safety
/// `f` must come from `gs_new` and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn gs_free(f: *mut Field) {
    drop(Box::from_raw(f))
}

#[no_mangle]
pub unsafe extern "C" fn gs_step(f: *mut Field, iterations: u32) {
    (*f).step(iterations as usize)
}

#[no_mangle]
pub unsafe extern "C" fn gs_drop(f: *mut Field, x: f32, y: f32, r: f32) {
    (*f).drop(x, y, r)
}

#[no_mangle]
pub unsafe extern "C" fn gs_set_reagent(f: *mut Field, x: f32) {
    (*f).set_reagent(x)
}

#[no_mangle]
pub unsafe extern "C" fn gs_view_ptr(f: *mut Field) -> *const u8 {
    (*f).view.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn gs_coverage(f: *mut Field) -> f32 {
    (*f).coverage
}

#[no_mangle]
pub unsafe extern "C" fn gs_activity(f: *mut Field) -> f32 {
    (*f).activity
}
