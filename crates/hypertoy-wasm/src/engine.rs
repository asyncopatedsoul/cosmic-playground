//! The audio engine: a fixed pool of toy slots, the beat clock, the Tuning,
//! a shared reverb and the master limiter. Runs inside the AudioWorklet.
//!
//! Each slot holds a [`Voice`]; built-in toys and toys described as data go
//! through the same trait. Voices are created and loaded only between blocks
//! (in the worklet's command phase); `process` never allocates.
//!
//! Param ids, kinds, the snapshot layout and the event layout are mirrored in
//! `apps/playground/src/audio/protocol.ts`; change both together.

use crate::builtin::{Kettle, Orrery, Spire};
use crate::custom::{Arg, Custom};
use crate::voice::{Ctx, Fx, Silent, Tick, Voice, PARAMS};
use hypertoy_core::pattern::{ParseError, Pattern};
use hypertoy_core::{
    clock::Clock,
    pulse::Pulse,
    scala,
    tuning::{midi_to_hz, Scale, Table, Tuning},
};
use hypertoy_dsp::patch::{Patch, PatchError};
use hypertoy_dsp::{Limiter, Reverb};
use hypertoy_laws::law::MAX_ARGS;

pub const BLOCK: usize = 128;
pub const MAX_TOYS: usize = 16;

pub const SNAP_HEADER: usize = 8;
pub const SNAP_STRIDE: usize = 24;
pub const SNAP_LEN: usize = SNAP_HEADER + MAX_TOYS * SNAP_STRIDE;

/// Words in the scratch buffer the host writes configs, patterns and tables into.
pub const SCRATCH_LEN: usize = 8192;
/// Events per block reported to the host (for external voice modules).
pub const MAX_EVENTS: usize = 256;
pub const EVENT_STRIDE: usize = 5;
/// `set_tuning` with this scale id keeps the current (custom) table.
pub const SCALE_CUSTOM: u32 = 99;

pub mod kind {
    pub const NONE: u32 = 0;
    pub const SPIRE: u32 = 1;
    pub const ORRERY: u32 = 2;
    pub const KETTLE: u32 = 3;
    /// A toy described as data; its Law and Voice arrive as `toy_set_law` /
    /// `toy_load_*` commands after `toy_add`.
    pub const CUSTOM: u32 = 4;
}

pub mod param {
    pub const PAN: usize = 0;
    pub const GAIN: usize = 1;
    pub const PULSE_ON: usize = 2;
    pub const STEPS_PER_BEAT: usize = 3;
    pub const STEPS: usize = 4;
    pub const SPEED: usize = 5;
    /// The listener's own level for this toy (mute/solo/focus, AUDIO-MIX.md §3).
    /// Applied after the bus tap, so listening toys and visuals never hear it.
    pub const MONITOR: usize = 6;
    /// Toy-specific params start here.
    /// Spire: A length (m), B tension (0..1), C harmonic (1..8).
    /// Orrery: A..D planet orbit radii (0 = no planet).
    /// Kettle: A coverage (0..1), B activity (0..1), C reagent (0..1).
    /// Custom: A + i is the config's i-th param, in declaration order.
    pub const A: usize = 8;
    pub const B: usize = 9;
    pub const C: usize = 10;
}

/// Event kinds in the per-block event list: `[slot, frame, kind, a, b]`.
pub mod event {
    /// A note began: a = velocity, b = frequency (Hz).
    pub const NOTE: f32 = 1.0;
    /// A param changed: a = param id, b = value.
    pub const PARAM: f32 = 2.0;
}

const REVERB_SEND: f32 = 0.35;
/// Time constant of the gain, monitor and master ramps: changes never click.
const RAMP_S: f32 = 0.010;

struct Slot {
    kind: u32,
    params: [f32; PARAMS],
    pulse: Pulse,
    voice: Box<dyn Voice>,
    env: f32,
    flash: f32,
    /// Smoothed `GAIN` and `MONITOR`, following the params one sample at a time.
    gain: f32,
    monitor: f32,
    /// Per-toy wild: this toy's pitch isn't snapped (see `Ctx::wild`).
    wild: bool,
    /// Report every note as an event (polyphonic toys feeding chord goals, MODES.md §3.3).
    report_notes: bool,
}

impl Slot {
    fn empty() -> Self {
        Slot {
            kind: kind::NONE,
            params: [0.0; PARAMS],
            pulse: Pulse::default(),
            voice: Box::new(Silent),
            env: 0.0,
            flash: 0.0,
            gain: 1.0,
            monitor: 1.0,
            wild: false,
            report_notes: false,
        }
    }
}

/// Failures of the load commands, as negative codes for the host.
#[derive(Debug, PartialEq, Eq)]
pub enum LoadError {
    NoSlot,
    NotCustom,
    TooLong,
    Patch(PatchError),
    Pattern(ParseError),
    Table,
}

impl LoadError {
    /// `-1` no slot, `-2` not custom, `-3` too long, `-4` bad table,
    /// `-100 - word` bad patch, `-1000 - byte` bad pattern.
    pub fn code(&self) -> i32 {
        match self {
            LoadError::NoSlot => -1,
            LoadError::NotCustom => -2,
            LoadError::TooLong => -3,
            LoadError::Table => -4,
            LoadError::Patch(e) => {
                -100 - match e {
                    PatchError::BadTerm { word } => *word as i32,
                    _ => 0,
                }
            }
            LoadError::Pattern(e) => -1000 - e.at as i32,
        }
    }
}

pub struct Engine {
    pub clock: Clock,
    pub tuning: Tuning,
    /// Master gain target; the output ramps to it (so muting is a fade, not a click).
    pub master: f32,
    master_now: f32,
    /// One-pole coefficient for `RAMP_S`.
    ramp: f32,
    pub out: [f32; BLOCK * 2],
    pub snap: [f32; SNAP_LEN],
    /// Host-written audio for external voices: per slot, BLOCK left then BLOCK right.
    pub ext: Vec<f32>,
    /// Each slot's post-gain mono output for the last block (audio inputs for modules).
    pub bus: Vec<f32>,
    pub scratch: Vec<f32>,
    pub events: [f32; MAX_EVENTS * EVENT_STRIDE],
    pub n_events: usize,
    slots: Vec<Slot>,
    reverb: Reverb,
    limiter: Limiter,
    seed: u64,
    sr: f32,
}

impl Engine {
    pub fn new(sr: f32) -> Self {
        Engine {
            clock: Clock::new(sr as f64, 96.0),
            tuning: Tuning::default(),
            master: 0.7,
            master_now: 0.7,
            ramp: 1.0 - (-1.0 / (RAMP_S * sr)).exp(),
            out: [0.0; BLOCK * 2],
            snap: [0.0; SNAP_LEN],
            ext: vec![0.0; MAX_TOYS * BLOCK * 2],
            bus: vec![0.0; MAX_TOYS * BLOCK],
            scratch: vec![0.0; SCRATCH_LEN],
            events: [0.0; MAX_EVENTS * EVENT_STRIDE],
            n_events: 0,
            slots: (0..MAX_TOYS).map(|_| Slot::empty()).collect(),
            reverb: Reverb::new(sr),
            limiter: Limiter::new(sr),
            seed: 0xC05_A11C,
            sr,
        }
    }

    fn ctx<'a>(params: &'a [f32; PARAMS], wild: bool, tuning: &'a Tuning, sr: f32, seed: u64, index: usize) -> Ctx<'a> {
        Ctx { params, tuning, sr, seed, index, wild }
    }

    fn configure(&mut self, slot: usize) {
        let s = &mut self.slots[slot];
        let cx = Self::ctx(&s.params, s.wild, &self.tuning, self.sr, self.seed, slot);
        s.voice.configure(&cx);
    }

    fn configure_all(&mut self) {
        for i in 0..MAX_TOYS {
            self.configure(i);
        }
    }

    pub fn set_tuning(&mut self, root_midi: f32, scale: u32, wild: bool) {
        self.tuning.root_hz = midi_to_hz(root_midi);
        self.tuning.wild = wild;
        if scale != SCALE_CUSTOM {
            self.tuning.table = Table::from_scale(Scale::from_id(scale));
        }
        self.configure_all();
    }

    /// Scratch words `[period, tone, tone, ...]` (cents) become the Tuning's table.
    pub fn set_tuning_table(&mut self, len: usize) -> Result<(), LoadError> {
        let w = self.scratch_words(len)?;
        if w.is_empty() {
            return Err(LoadError::Table);
        }
        self.tuning.table = Table::from_cents(&w[1..], w[0]).ok_or(LoadError::Table)?;
        self.configure_all();
        Ok(())
    }

    /// Scratch bytes hold a Scala `.scl` file.
    pub fn set_tuning_scl(&mut self, len: usize) -> Result<(), LoadError> {
        let text = self.scratch_text(len)?;
        let table = scala::parse(&text).map_err(|_| LoadError::Table)?;
        self.tuning.table = table;
        self.configure_all();
        Ok(())
    }

    pub fn add_toy(&mut self, slot: usize, k: u32) {
        let sr = self.sr;
        let Some(s) = self.slots.get_mut(slot) else { return };
        s.kind = k;
        s.params = [0.0; PARAMS];
        s.params[param::GAIN] = 1.0;
        s.params[param::MONITOR] = 1.0;
        s.params[param::SPEED] = 1.0;
        s.pulse = Pulse::default();
        s.env = 0.0;
        s.flash = 0.0;
        // A new toy starts at its own levels, not fading from the slot's last toy.
        s.gain = 1.0;
        s.monitor = 1.0;
        s.wild = false;
        s.report_notes = false;
        s.voice = match k {
            kind::SPIRE => Box::new(Spire::new(sr, slot)),
            kind::ORRERY => Box::new(Orrery::new()),
            kind::KETTLE => Box::new(Kettle::new(slot)),
            kind::CUSTOM => Box::new(Custom::new(sr)),
            _ => {
                s.kind = kind::NONE;
                Box::new(Silent)
            }
        };
        self.ext[slot * BLOCK * 2..(slot + 1) * BLOCK * 2].fill(0.0);
        self.configure(slot);
    }

    /// Turn snapping off (or back on) for one toy.
    pub fn set_wild(&mut self, slot: usize, wild: bool) {
        if let Some(s) = self.slots.get_mut(slot) {
            s.wild = wild;
            self.configure(slot);
        }
    }

    /// Ask for (or stop) note events from one slot, beyond the external voices that always send them.
    pub fn set_report_notes(&mut self, slot: usize, on: bool) {
        if let Some(s) = self.slots.get_mut(slot) {
            s.report_notes = on;
        }
    }

    pub fn remove_toy(&mut self, slot: usize) {
        if let Some(s) = self.slots.get_mut(slot) {
            *s = Slot::empty();
        }
    }

    pub fn set_param(&mut self, slot: usize, p: usize, v: f32) {
        let beat = self.clock.beat;
        let Some(s) = self.slots.get_mut(slot) else { return };
        // A NaN here would poison the reverb forever; ignore it.
        if p >= PARAMS || !v.is_finite() {
            return;
        }
        let was = s.params[p];
        s.params[p] = v;
        match p {
            param::PULSE_ON => s.pulse.enabled = v > 0.5,
            param::STEPS_PER_BEAT => s.pulse.steps_per_beat = v.clamp(0.25, 8.0) as f64,
            param::STEPS => s.pulse.steps = (v as usize).clamp(1, hypertoy_core::pulse::MAX_STEPS),
            _ => {}
        }
        let external = s.voice.external();
        let cx = Self::ctx(&s.params, s.wild, &self.tuning, self.sr, self.seed, slot);
        s.voice.param_set(p, was, &cx, beat);
        s.voice.configure(&cx);
        if external && p >= param::A {
            self.push_event(slot, 0, event::PARAM, p as f32, v);
        }
    }

    pub fn set_step(&mut self, slot: usize, step: usize, prob: f32) {
        if let Some(s) = self.slots.get_mut(slot) {
            if step < hypertoy_core::pulse::MAX_STEPS && prob.is_finite() {
                s.pulse.prob[step] = prob.clamp(0.0, 1.0);
            }
        }
    }

    /// Scratch bytes hold a mini-notation pattern; empty clears it (back to the ring).
    pub fn set_pattern(&mut self, slot: usize, len: usize) -> Result<(), LoadError> {
        if slot >= MAX_TOYS {
            return Err(LoadError::NoSlot);
        }
        let pattern = if len == 0 {
            None
        } else {
            let text = self.scratch_text(len)?;
            Some(Pattern::parse(&text).map_err(LoadError::Pattern)?)
        };
        self.slots[slot].pulse.set_pattern(pattern);
        Ok(())
    }

    pub fn poke(&mut self, slot: usize, strength: f32, _aux: f32) {
        let Some(s) = self.slots.get_mut(slot) else { return };
        let mut fx = Fx::default();
        let cx = Self::ctx(&s.params, s.wild, &self.tuning, self.sr, self.seed, slot);
        s.voice.poke(strength.clamp(0.0, 1.0), &cx, &mut fx);
        if fx.flash {
            s.flash = 1.0;
        }
        if s.voice.external() || s.report_notes {
            for &(vel, hz) in fx.notes() {
                self.push_event(slot, 0, event::NOTE, vel, hz);
            }
        }
    }

    fn custom(&mut self, slot: usize) -> Result<&mut Custom, LoadError> {
        let s = self.slots.get_mut(slot).ok_or(LoadError::NoSlot)?;
        if s.kind != kind::CUSTOM {
            return Err(LoadError::NotCustom);
        }
        s.voice.as_custom().ok_or(LoadError::NotCustom)
    }

    /// Scratch words: 4 x (param or -1, mul, add).
    pub fn set_law(&mut self, slot: usize, law: u32, wild: bool) -> Result<(), LoadError> {
        let mut args = [Arg::default(); MAX_ARGS];
        for (i, a) in args.iter_mut().enumerate() {
            let w = &self.scratch[i * 3..i * 3 + 3];
            let p = w[0];
            a.param = (p >= 0.0 && p.fract() == 0.0 && (p as usize) < PARAMS - param::A).then_some(p as usize);
            a.mul = if w[1].is_finite() { w[1] } else { 0.0 };
            a.add = if w[2].is_finite() { w[2] } else { 0.0 };
        }
        self.custom(slot)?.set_law(law, args, wild);
        self.configure(slot);
        Ok(())
    }

    /// Scratch words: a patch program (see `hypertoy_dsp::patch`).
    pub fn load_patch(&mut self, slot: usize, len: usize, voices: usize, gate_s: f32) -> Result<(), LoadError> {
        let seed = self.toy_seed(slot);
        let patch = Patch::build(self.scratch_words(len)?, self.sr, seed).map_err(LoadError::Patch)?;
        self.custom(slot)?.set_patch(patch, voices, gate_s);
        self.configure(slot);
        Ok(())
    }

    /// Scratch words: 21 recipe numbers, then (recipe slot, param) pairs.
    pub fn load_zap(&mut self, slot: usize, len: usize) -> Result<(), LoadError> {
        let w = self.scratch_words(len)?;
        let n = w.len().min(hypertoy_dsp::zap::RECIPE_LEN);
        let recipe: Vec<f32> = w[..n].to_vec();
        let binds: Vec<(usize, usize)> = w[n..]
            .chunks_exact(2)
            .filter(|c| c[0] >= 0.0 && c[1] >= 0.0)
            .map(|c| (c[0] as usize, c[1] as usize))
            .collect();
        let seed = self.toy_seed(slot) as u32;
        self.custom(slot)?.set_zap(&recipe, &binds, seed);
        self.configure(slot);
        Ok(())
    }

    pub fn load_external(&mut self, slot: usize) -> Result<(), LoadError> {
        self.custom(slot)?.set_external();
        self.configure(slot);
        Ok(())
    }

    fn toy_seed(&self, slot: usize) -> u64 {
        self.seed ^ (slot as u64).wrapping_mul(0x100_0000_01B3)
    }

    fn scratch_words(&self, len: usize) -> Result<&[f32], LoadError> {
        self.scratch.get(..len).ok_or(LoadError::TooLong)
    }

    /// Scratch bytes as UTF-8 (lossy; patterns and .scl are ASCII).
    fn scratch_text(&self, len: usize) -> Result<String, LoadError> {
        if len > SCRATCH_LEN * 4 {
            return Err(LoadError::TooLong);
        }
        // The host writes raw bytes over the f32 words; view them as bytes (no float loads).
        // SAFETY: the scratch Vec holds SCRATCH_LEN * 4 initialised bytes and len is within that.
        let bytes = unsafe { core::slice::from_raw_parts(self.scratch.as_ptr() as *const u8, len) };
        Ok(String::from_utf8_lossy(bytes).into_owned())
    }

    fn push_event(&mut self, slot: usize, frame: usize, kind: f32, a: f32, b: f32) {
        if self.n_events < MAX_EVENTS {
            let o = self.n_events * EVENT_STRIDE;
            self.events[o..o + EVENT_STRIDE].copy_from_slice(&[slot as f32, frame as f32, kind, a, b]);
            self.n_events += 1;
        }
    }

    pub fn clear_events(&mut self) {
        self.n_events = 0;
    }

    pub fn process(&mut self, frames: usize) {
        let frames = frames.min(BLOCK);
        let dbeat = self.clock.beats_per_sample();
        let k = self.ramp;
        for i in 0..frames {
            let beat = self.clock.beat;
            self.master_now += k * (self.master - self.master_now);
            let (mut l, mut r, mut send) = (0.0f32, 0.0f32, 0.0f32);
            for idx in 0..MAX_TOYS {
                let s = &mut self.slots[idx];
                if s.kind == kind::NONE {
                    continue;
                }
                let toy_seed = self.seed ^ (idx as u64).wrapping_mul(0x100_0000_01B3);
                let hit = s.pulse.tick(beat, toy_seed);
                let e = idx * BLOCK * 2;
                let t = Tick {
                    beat,
                    dbeat,
                    hit,
                    pulse_on: s.pulse.enabled,
                    frame: i,
                    ext: (self.ext[e + i], self.ext[e + BLOCK + i]),
                };
                let mut fx = Fx::default();
                let cx = Ctx { params: &s.params, tuning: &self.tuning, sr: self.sr, seed: self.seed, index: idx, wild: s.wild };
                let (yl, yr) = s.voice.tick(&cx, &t, &mut fx);
                s.gain += k * (s.params[param::GAIN].clamp(0.0, 1.0) - s.gain);
                s.monitor += k * (s.params[param::MONITOR].clamp(0.0, 1.0) - s.monitor);
                let (yl, yr) = (yl * s.gain, yr * s.gain);
                // The bus tap and the visuals take the toy's level in the music;
                // everything after this is only what this listener hears.
                let mono = 0.5 * (yl + yr);
                s.env = mono.abs().max(s.env * 0.9995);
                self.bus[idx * BLOCK + i] = mono;
                let (yl, yr) = (yl * s.monitor, yr * s.monitor);
                let pan = s.params[param::PAN].clamp(-1.0, 1.0);
                let (gl, gr) = if s.voice.stereo() {
                    // Balance: turn down the far side.
                    ((1.0 - pan).min(1.0), (1.0 + pan).min(1.0))
                } else {
                    // Equal-power pan.
                    let theta = (pan + 1.0) * core::f32::consts::FRAC_PI_4;
                    (theta.cos(), theta.sin())
                };
                l += yl * gl;
                r += yr * gr;
                send += mono * s.monitor;
                s.flash *= 0.9997;
                if fx.flash {
                    s.flash = 1.0;
                }
                if s.voice.external() || s.report_notes {
                    for &(vel, hz) in fx.notes() {
                        self.push_event(idx, i, event::NOTE, vel, hz);
                    }
                }
            }
            let (rl, rr) = self.reverb.tick(send * REVERB_SEND);
            let m = self.master_now;
            let (ol, or) = self.limiter.tick((l + rl) * m, (r + rr) * m);
            self.out[i] = ol;
            self.out[BLOCK + i] = or;
            self.clock.advance();
        }
        self.write_snapshot();
    }

    fn write_snapshot(&mut self) {
        self.snap[0] = self.clock.beat as f32;
        self.snap[1] = self.clock.bpm as f32;
        for (i, s) in self.slots.iter().enumerate() {
            let o = SNAP_HEADER + i * SNAP_STRIDE;
            let v = &mut self.snap[o..o + SNAP_STRIDE];
            v[0] = s.kind as f32;
            v[1] = s.env;
            v[2] = s.voice.freq();
            v[3] = s.pulse.current_step() as f32;
            v[4] = s.flash;
            v[5] = if s.pulse.enabled { 1.0 } else { 0.0 };
            v[6..].fill(0.0);
            s.voice.snapshot(&mut v[6..]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hypertoy_dsp::patch::op;

    fn render(e: &mut Engine, seconds: f32) -> Vec<f32> {
        let blocks = (seconds * e.sr / BLOCK as f32) as usize;
        let mut out = Vec::with_capacity(blocks * BLOCK);
        for _ in 0..blocks {
            e.process(BLOCK);
            out.extend_from_slice(&e.out[..BLOCK]);
        }
        out
    }

    fn peak(x: &[f32]) -> f32 {
        x.iter().fold(0.0f32, |m, v| m.max(v.abs()))
    }

    /// Coarse spectral fingerprint: energy in 8 bands of a crude filterbank
    /// (one-pole splits). Golden-audio tests compare these, not raw samples.
    fn fingerprint(x: &[f32]) -> [f32; 8] {
        let mut lp = [0.0f32; 8];
        let mut out = [0.0f32; 8];
        for &s in x {
            let mut prev = s;
            for b in 0..8 {
                let a = 0.5f32.powi(b as i32 + 1);
                lp[b] += a * (prev - lp[b]);
                out[b] += (prev - lp[b]).powi(2);
                prev = lp[b];
            }
        }
        out.map(|e| (e / x.len() as f32).sqrt())
    }

    #[test]
    fn silent_when_empty() {
        let mut e = Engine::new(48_000.0);
        assert!(render(&mut e, 0.5).iter().all(|&x| x.abs() < 1e-6));
    }

    #[test]
    fn spire_pulse_makes_sound_and_never_clips() {
        let mut e = Engine::new(48_000.0);
        e.add_toy(0, kind::SPIRE);
        e.set_param(0, param::A, 1.0);
        e.set_param(0, param::B, 0.5);
        e.set_param(0, param::C, 1.0);
        e.set_param(0, param::PULSE_ON, 1.0);
        let out = render(&mut e, 3.0);
        let peak = peak(&out);
        assert!(peak > 0.05, "peak {peak}");
        assert!(peak <= 0.9);
    }

    #[test]
    fn orrery_transits_follow_kepler() {
        let mut e = Engine::new(48_000.0);
        e.add_toy(0, kind::ORRERY);
        e.set_param(0, param::PULSE_ON, 1.0);
        e.set_param(0, param::A, 1.0); // period 4 beats
        // 96 bpm: 4 beats = 2.5 s. After 5.1 s, two transits.
        let mut transits = 0;
        let mut last = 0.0;
        for _ in 0..(5.1 * 48_000.0 / BLOCK as f32) as usize {
            e.process(BLOCK);
            let f = e.snap[SNAP_HEADER + 10];
            if f > last + 0.5 {
                transits += 1;
            }
            last = f;
        }
        assert_eq!(transits, 2);
    }

    #[test]
    fn ignores_nan_params() {
        let mut e = Engine::new(48_000.0);
        e.add_toy(0, kind::KETTLE);
        e.set_param(0, param::PAN, f32::NAN);
        e.poke(0, 1.0, 0.0);
        assert!(render(&mut e, 0.5).iter().all(|x| x.is_finite()));
    }

    #[test]
    fn deterministic_render() {
        let run = || {
            let mut e = Engine::new(48_000.0);
            e.add_toy(3, kind::KETTLE);
            e.set_param(3, param::A, 0.5);
            e.set_param(3, param::B, 0.5);
            e.set_param(3, param::PULSE_ON, 1.0);
            render(&mut e, 1.0)
        };
        assert_eq!(run(), run());
    }

    /// Golden fingerprints of the three built-in toys, recorded before the
    /// Voice refactor (see `golden_values`). The refactor must not change them.
    #[test]
    fn builtin_toys_match_their_golden_fingerprints() {
        for (k, want) in golden_values() {
            let got = golden_render(k);
            for (b, (g, w)) in got.iter().zip(want).enumerate() {
                let tol = 0.02 * w.max(1e-4) + 1e-6;
                assert!((g - w).abs() <= tol, "kind {k} band {b}: got {g}, want {w}");
            }
        }
    }

    fn golden_render(k: u32) -> [f32; 8] {
        let mut e = Engine::new(48_000.0);
        e.add_toy(0, k);
        match k {
            kind::SPIRE => {
                e.set_param(0, param::A, 1.0);
                e.set_param(0, param::B, 0.5);
                e.set_param(0, param::C, 2.0);
            }
            kind::ORRERY => {
                e.set_param(0, param::A, 1.0);
                e.set_param(0, param::B, 1.6);
            }
            _ => {
                e.set_param(0, param::A, 0.6);
                e.set_param(0, param::B, 0.4);
            }
        }
        e.set_param(0, param::PULSE_ON, 1.0);
        e.poke(0, 0.8, 0.0);
        fingerprint(&render(&mut e, 4.0))
    }

    fn golden_values() -> [(u32, [f32; 8]); 3] {
        GOLDEN
    }

    include!("golden.rs");

    /// Write the scratch buffer the way the host does.
    fn scratch(e: &mut Engine, words: &[f32]) -> usize {
        e.scratch[..words.len()].copy_from_slice(words);
        words.len()
    }

    fn scratch_text(e: &mut Engine, text: &str) -> usize {
        let mut bytes = text.as_bytes().to_vec();
        bytes.resize(bytes.len().div_ceil(4) * 4, 0);
        for (i, c) in bytes.chunks_exact(4).enumerate() {
            e.scratch[i] = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        }
        text.len()
    }

    /// pluck(trig, freq, 0.3) with the freq from a string Law bound to param 0 (length).
    fn custom_string_toy(e: &mut Engine, slot: usize) {
        e.add_toy(slot, kind::CUSTOM);
        e.set_param(slot, param::A, 1.0);
        // length = param0, tension = 100 N, density 0.001, harmonic 1
        scratch(e, &[0.0, 1.0, 0.0, -1.0, 0.0, 100.0, -1.0, 0.0, 0.001, -1.0, 0.0, 1.0]);
        e.set_law(slot, hypertoy_laws::law::STRING, false).unwrap();
        let w = [
            1.0, 1.0, 1.0, // version, mono, one node
            op::PLUCK as f32, 0.0, // pluck, no args
            1.0, 1.0, 2.0, 0.0, 1.0, // trig <- input 2
            1.0, 1.0, 0.0, 0.0, 1.0, // freq <- input 0
            1.0, 0.0, 0.3, 0.0, 1.0, // brightness 0.3
            1.0, 2.0, 0.0, 0.0, 1.0, // out <- node 0
        ];
        let n = scratch(e, &w);
        e.load_patch(slot, n, 2, 0.1).unwrap();
    }

    #[test]
    fn custom_patch_toy_follows_its_law_and_tuning() {
        let mut e = Engine::new(48_000.0);
        custom_string_toy(&mut e, 2);
        // f = sqrt(100 / 0.001) / 2 = 158.1 Hz, snapped to C major pentatonic.
        let f = e.snap_freq_after_block(2);
        assert!((f - e.tuning.snap(158.11)).abs() < 0.01, "{f}");
        e.set_param(2, param::A, 0.5); // half the length: an octave up
        assert!((e.snap_freq_after_block(2) / f - 2.0).abs() < 0.01);
        e.poke(2, 0.9, 0.0);
        let out = render(&mut e, 1.0);
        assert!(peak(&out) > 0.05 && peak(&out) <= 0.9);
    }

    #[test]
    fn custom_toy_plays_a_scripted_pattern_with_degrees() {
        let mut e = Engine::new(48_000.0);
        custom_string_toy(&mut e, 0);
        let n = scratch_text(&mut e, "0 . 2 4");
        e.set_pattern(0, n).unwrap();
        e.set_param(0, param::PULSE_ON, 1.0);
        let out = render(&mut e, 2.5); // one 4-beat cycle at 96 bpm
        assert!(peak(&out) > 0.05);
        assert_eq!(scratch_text(&mut e, "0 ["), 3);
        assert_eq!(e.set_pattern(0, 3).unwrap_err().code(), -1003);
        assert!(e.set_pattern(0, 0).is_ok());
    }

    #[test]
    fn zap_toy_with_bound_param() {
        let play = |volume: f32| {
            let mut e = Engine::new(48_000.0);
            e.add_toy(1, kind::CUSTOM);
            scratch(&mut e, &[-1.0, 0.0, 440.0, -1.0, 0.0, 0.0, -1.0, 0.0, 0.0, -1.0, 0.0, 0.0]);
            e.set_law(1, hypertoy_laws::law::FIXED, true).unwrap();
            // Default recipe with a sustain; recipe slot 0 (volume) <- param 0.
            let mut w = hypertoy_dsp::zap::DEFAULTS.to_vec();
            w[4] = 0.2;
            w.extend([0.0, 0.0]);
            let n = scratch(&mut e, &w);
            e.load_zap(1, n).unwrap();
            e.set_param(1, param::A, volume);
            e.poke(1, 1.0, 0.0);
            let out = render(&mut e, 0.3);
            assert!(e.snap[SNAP_HEADER + SNAP_STRIDE + 2] == 440.0);
            peak(&out)
        };
        let (loud, quiet) = (play(1.0), play(0.25));
        assert!(loud > 0.1 && (quiet / loud - 0.25).abs() < 0.05, "{loud} {quiet}");
    }

    #[test]
    fn external_voice_reads_the_host_buffer_and_reports_events() {
        let mut e = Engine::new(48_000.0);
        e.add_toy(5, kind::CUSTOM);
        e.load_external(5).unwrap();
        e.set_param(5, param::A, 0.7);
        assert_eq!(e.n_events, 1);
        assert_eq!(&e.events[..5], &[5.0, 0.0, event::PARAM, param::A as f32, 0.7]);
        e.clear_events();
        let o = 5 * BLOCK * 2;
        e.ext[o..o + BLOCK].fill(0.25);
        e.ext[o + BLOCK..o + 2 * BLOCK].fill(-0.25);
        e.set_param(5, param::PULSE_ON, 1.0);
        e.process(BLOCK);
        // Stereo passes through (centred: full on both sides), and the Pulse's
        // first step at beat 0 is reported as a note at frame 0.
        assert!(e.out[BLOCK / 2] > 0.1 && e.out[BLOCK + BLOCK / 2] < -0.1);
        assert_eq!(e.events[2], event::NOTE);
        assert_eq!(e.events[1], 0.0);
        assert!((e.bus[5 * BLOCK]).abs() < 1e-6); // L + R cancel in the mono bus
    }

    /// A sustained, centred custom toy (no Pulse needed): a fixed 220 Hz sine.
    fn drone(e: &mut Engine, slot: usize) {
        e.add_toy(slot, kind::CUSTOM);
        scratch(e, &[-1.0, 0.0, 220.0, -1.0, 0.0, 0.0, -1.0, 0.0, 0.0, -1.0, 0.0, 0.0]);
        e.set_law(slot, hypertoy_laws::law::FIXED, true).unwrap();
        let w = [
            1.0, 1.0, 1.0, // version, mono, one node
            op::SINE as f32, 0.0, // sine, no args
            1.0, 1.0, 0.0, 0.0, 1.0, // freq <- input 0
            1.0, 2.0, 0.0, 0.0, 0.3, // out <- node 0 × 0.3
        ];
        let n = scratch(e, &w);
        e.load_patch(slot, n, 1, 10.0).unwrap();
        e.poke(slot, 1.0, 0.0);
    }

    /// Largest sample-to-sample step: a click shows up as a jump far above the
    /// signal's own slope (a 220 Hz sine at 0.3 moves at most ~0.009 per sample).
    fn max_step(x: &[f32]) -> f32 {
        x.windows(2).fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()))
    }

    #[test]
    fn monitor_mutes_what_you_hear_but_not_the_bus_or_the_visuals() {
        let mut e = Engine::new(48_000.0);
        drone(&mut e, 0);
        let before = render(&mut e, 0.5);
        assert!(peak(&before[before.len() - 4800..]) > 0.05);
        let bus_before = peak(&e.bus[..BLOCK]);
        e.set_param(0, param::MONITOR, 0.0);
        let after = render(&mut e, 1.0);
        // Ramps out with no click; only the shared reverb's tail is left after it.
        assert!(max_step(&after[..480]) < 0.02, "click: {}", max_step(&after[..480]));
        let (was, now) = (peak(&before[before.len() - 4800..]), peak(&after[after.len() - 4800..]));
        assert!(now < 0.1 * was, "{now} vs {was}");
        // Listening toys and the snapshot still see the toy at full level.
        assert!((peak(&e.bus[..BLOCK]) - bus_before).abs() < 0.05 * bus_before);
        assert!(e.snap[SNAP_HEADER + 1] > 0.05);
    }

    #[test]
    fn gain_and_master_ramp_without_clicks() {
        let mut e = Engine::new(48_000.0);
        drone(&mut e, 0);
        render(&mut e, 0.5);
        e.set_param(0, param::GAIN, 0.2);
        assert!(max_step(&render(&mut e, 0.05)) < 0.02);
        e.set_param(0, param::GAIN, 1.0);
        render(&mut e, 0.1);
        e.master = 0.0;
        let muted = render(&mut e, 0.3);
        assert!(max_step(&muted[..480]) < 0.02);
        assert!(peak(&muted[muted.len() - 4800..]) < 1e-3);
        // The engine keeps running while muted: the beat moves on.
        let beat = e.clock.beat;
        render(&mut e, 0.1);
        assert!(e.clock.beat > beat);
    }

    /// NOTE events in the current event list for `slot`.
    fn notes_for(e: &Engine, slot: usize) -> Vec<(f32, f32)> {
        e.events[..e.n_events * EVENT_STRIDE]
            .chunks_exact(EVENT_STRIDE)
            .filter(|ev| ev[0] as usize == slot && ev[2] == event::NOTE)
            .map(|ev| (ev[3], ev[4]))
            .collect()
    }

    #[test]
    fn subscribed_slots_report_every_note() {
        let mut e = Engine::new(48_000.0);
        e.add_toy(0, kind::KETTLE);
        e.add_toy(1, kind::ORRERY);
        e.set_param(1, param::A, 1.0);
        e.set_param(1, param::B, 1.6);
        // Not subscribed: built-in toys report nothing.
        e.poke(0, 1.0, 0.0);
        e.poke(1, 1.0, 0.0);
        assert_eq!(e.n_events, 0);
        // Subscribed: a Kettle poke is two bubbles, an Orrery poke rings both planets.
        e.set_report_notes(0, true);
        e.set_report_notes(1, true);
        e.poke(0, 1.0, 0.0);
        e.poke(1, 1.0, 0.0);
        let kettle = notes_for(&e, 0);
        let orrery = notes_for(&e, 1);
        assert_eq!(kettle.len(), 2);
        assert_eq!(orrery.len(), 2);
        assert!(orrery[0].1 != orrery[1].1, "two planets, two pitches: {orrery:?}");
        // Every reported pitch is a scale tone (the bubbles are snapped).
        for &(_, hz) in kettle.iter().chain(&orrery) {
            assert!((e.tuning.snap(hz) - hz).abs() < 1e-3, "{hz}");
        }
        e.clear_events();
        // Pulse hits during a block are reported at their frame.
        e.set_param(0, param::PULSE_ON, 1.0);
        e.set_step(0, 0, 1.0);
        e.process(BLOCK);
        let first = notes_for(&e, 0);
        assert_eq!(first.len(), 1, "the beat-0 step");
        assert_eq!(e.events[1], 0.0, "at frame 0");
        // Unsubscribing stops them; a new toy in the slot starts unsubscribed.
        e.clear_events();
        e.set_report_notes(0, false);
        e.poke(0, 1.0, 0.0);
        assert!(notes_for(&e, 0).is_empty());
        e.set_report_notes(1, true);
        e.add_toy(1, kind::KETTLE);
        e.poke(1, 1.0, 0.0);
        assert!(notes_for(&e, 1).is_empty());
    }

    #[test]
    fn load_errors_are_codes_not_panics() {
        let mut e = Engine::new(48_000.0);
        assert_eq!(e.load_external(0).unwrap_err(), LoadError::NotCustom);
        assert_eq!(e.load_external(99).unwrap_err(), LoadError::NoSlot);
        e.add_toy(0, kind::CUSTOM);
        let n = scratch(&mut e, &[1.0, 1.0, 1.0, 99.0]);
        assert!(e.load_patch(0, n, 1, 0.1).unwrap_err().code() <= -100);
        assert_eq!(e.load_patch(0, SCRATCH_LEN + 1, 1, 0.1).unwrap_err(), LoadError::TooLong);
        let n = scratch(&mut e, &[f32::NAN]);
        assert_eq!(e.set_tuning_table(n).unwrap_err(), LoadError::Table);
    }

    #[test]
    fn tuning_tables_and_scala_reach_the_toys() {
        let mut e = Engine::new(48_000.0);
        custom_string_toy(&mut e, 0);
        let edo: Vec<f32> = core::iter::once(1200.0).chain((0..31).map(|i| i as f32 * 1200.0 / 31.0)).collect();
        let n = scratch(&mut e, &edo);
        e.set_tuning_table(n).unwrap();
        assert_eq!(e.tuning.table.tones().len(), 31);
        // The table survives a root change sent with the custom scale id.
        e.set_tuning(62.0, SCALE_CUSTOM, false);
        assert_eq!(e.tuning.table.tones().len(), 31);
        let n = scratch_text(&mut e, "tritave\n2\n9/7\n3/1\n");
        e.set_tuning_scl(n).unwrap();
        assert!((e.tuning.table.period - 1901.955).abs() < 0.01);
        e.set_tuning(60.0, 0, false);
        assert_eq!(e.tuning.table.tones().len(), 5);
    }

    impl Engine {
        fn snap_freq_after_block(&mut self, slot: usize) -> f32 {
            self.process(BLOCK);
            self.snap[SNAP_HEADER + slot * SNAP_STRIDE + 2]
        }
    }
}
