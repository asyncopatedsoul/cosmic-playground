//! Ring Listener: an example Voice Module (VMA, see docs/VMA.md) and a
//! template for native modules in any language that compiles to WASM.
//!
//! It listens: the audio input (another toy, or the microphone) is ring
//! modulated by a sine at the toy's Law frequency, opened by the gate, and
//! thrown across a stereo ping-pong echo. With no input it hums the sine.
//!
//! Inputs: 0 `freq` (Hz), 1 `gate` (0/1), 2 `depth` (0..1, input vs hum),
//! 3 `echo` (0..0.9 feedback). Audio: 2 in, 2 out.
//!
//! The ABI is plain C exports over the module's own memory. The host may only
//! read and write the buffers `vma_in_ptr` / `vma_out_ptr` return, so the
//! module must not grow memory after `vma_new`.

use core::f32::consts::TAU;

pub const BLOCK: usize = 128;
const INPUTS: u32 = 4;
const ECHO_S: f32 = 0.6;

pub struct Ring {
    sr: f32,
    inputs: [f32; INPUTS as usize],
    ins: [[f32; BLOCK]; 2],
    outs: [[f32; BLOCK]; 2],
    phase: f32,
    env: f32,
    echo: [Vec<f32>; 2],
    w: usize,
}

impl Ring {
    pub fn new(sr: f32) -> Self {
        let len = (ECHO_S * sr) as usize + 1;
        Ring {
            sr,
            inputs: [220.0, 0.0, 0.7, 0.4],
            ins: [[0.0; BLOCK]; 2],
            outs: [[0.0; BLOCK]; 2],
            phase: 0.0,
            env: 0.0,
            echo: [vec![0.0; len], vec![0.0; len]],
            w: 0,
        }
    }

    pub fn set(&mut self, id: u32, v: f32) {
        if id < INPUTS && v.is_finite() {
            self.inputs[id as usize] = v;
        }
    }

    pub fn process(&mut self, frames: usize) {
        let [freq, gate, depth, fb] = self.inputs;
        let inc = freq.clamp(1.0, 8000.0) / self.sr;
        let (attack, release) = (1.0 - (-1.0 / (0.005 * self.sr)).exp(), 1.0 - (-1.0 / (0.4 * self.sr)).exp());
        let fb = fb.clamp(0.0, 0.9);
        let depth = depth.clamp(0.0, 1.0);
        let len = self.echo[0].len();
        let d = len - 1;
        for i in 0..frames.min(BLOCK) {
            let target = if gate > 0.5 { 1.0 } else { 0.0 };
            self.env += (target - self.env) * if target > self.env { attack } else { release };
            let carrier = (TAU * self.phase).sin();
            self.phase = (self.phase + inc).fract();
            let heard = 0.5 * (self.ins[0][i] + self.ins[1][i]);
            let dry = (heard * carrier * depth + carrier * 0.25 * (1.0 - depth)) * self.env;
            // Ping-pong: each side feeds the other.
            let r = (self.w + len - d) % len;
            let (el, er) = (self.echo[0][r], self.echo[1][r]);
            self.echo[0][self.w] = dry + er * fb;
            self.echo[1][self.w] = el * fb;
            self.w = (self.w + 1) % len;
            self.outs[0][i] = dry + 0.5 * el;
            self.outs[1][i] = dry * 0.6 + 0.5 * er;
        }
    }
}

// ---- the VMA ABI ------------------------------------------------------------

#[no_mangle]
pub extern "C" fn vma_new(sample_rate: f32) -> *mut Ring {
    Box::into_raw(Box::new(Ring::new(sample_rate)))
}

#[no_mangle]
pub extern "C" fn vma_inputs(_h: *mut Ring) -> u32 {
    INPUTS
}

#[no_mangle]
pub extern "C" fn vma_audio_ins(_h: *mut Ring) -> u32 {
    2
}

#[no_mangle]
pub extern "C" fn vma_audio_outs(_h: *mut Ring) -> u32 {
    2
}

/// # Safety
/// `h` must come from `vma_new`. Same for every export below.
#[no_mangle]
pub unsafe extern "C" fn vma_in_ptr(h: *mut Ring, ch: u32) -> *mut f32 {
    (*h).ins[(ch as usize).min(1)].as_mut_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn vma_out_ptr(h: *mut Ring, ch: u32) -> *const f32 {
    (*h).outs[(ch as usize).min(1)].as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn vma_set(h: *mut Ring, id: u32, v: f32) {
    (*h).set(id, v)
}

#[no_mangle]
pub unsafe extern "C" fn vma_process(h: *mut Ring, frames: u32) {
    (*h).process(frames as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hums_when_gated_and_listens_to_its_input() {
        let mut r = Ring::new(48_000.0);
        r.set(0, 300.0);
        r.process(BLOCK);
        assert!(r.outs[0].iter().all(|&x| x == 0.0), "silent until gated");
        r.set(1, 1.0);
        r.set(2, 0.0); // all hum
        for _ in 0..40 {
            r.process(BLOCK);
        }
        let peak = r.outs[0].iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(peak > 0.1, "{peak}");
        // Full depth with silent input: only the echo tail remains, and it decays.
        r.set(2, 1.0);
        r.set(3, 0.0);
        for _ in 0..400 {
            r.process(BLOCK);
        }
        assert!(r.outs[0].iter().all(|&x| x.abs() < 1e-3));
        // Feed it a tone: it rings.
        for _ in 0..10 {
            r.ins[0] = core::array::from_fn(|i| (i as f32 * 0.1).sin());
            r.ins[1] = r.ins[0];
            r.process(BLOCK);
        }
        assert!(r.outs[1].iter().any(|&x| x.abs() > 0.05));
        assert!(r.outs.iter().flatten().all(|x| x.is_finite()));
    }
}
