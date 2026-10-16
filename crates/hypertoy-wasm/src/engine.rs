//! The audio engine: a fixed pool of toy slots, the beat clock, the Tuning,
//! a shared reverb and the master limiter. Runs inside the AudioWorklet.
//!
//! Param ids and the snapshot layout are mirrored in
//! `apps/playground/src/audio/protocol.ts`; change both together.

use core::f32::consts::TAU;
use hypertoy_core::{clock::Clock, pulse::Pulse, rng, tuning::{midi_to_hz, Scale, Tuning}};
use hypertoy_dsp::{Bell, Bubble, Limiter, Noise, Pluck, Reverb, Svf};
use hypertoy_laws::{bubble, kepler, string};

pub const BLOCK: usize = 128;
pub const MAX_TOYS: usize = 16;
pub const PLANETS: usize = 4;
const BUBBLES: usize = 6;
const BANDS: usize = 4;
const PARAMS: usize = 16;

pub const SNAP_HEADER: usize = 8;
pub const SNAP_STRIDE: usize = 24;
pub const SNAP_LEN: usize = SNAP_HEADER + MAX_TOYS * SNAP_STRIDE;

pub mod kind {
    pub const NONE: u32 = 0;
    pub const SPIRE: u32 = 1;
    pub const ORRERY: u32 = 2;
    pub const KETTLE: u32 = 3;
}

pub mod param {
    pub const PAN: usize = 0;
    pub const GAIN: usize = 1;
    pub const PULSE_ON: usize = 2;
    pub const STEPS_PER_BEAT: usize = 3;
    pub const STEPS: usize = 4;
    pub const SPEED: usize = 5;
    /// Toy-specific params start here.
    /// Spire: A length (m), B tension (0..1), C harmonic (1..8).
    /// Orrery: A..D planet orbit radii (0 = no planet).
    /// Kettle: A coverage (0..1), B activity (0..1), C reagent (0..1).
    pub const A: usize = 8;
    pub const B: usize = 9;
    pub const C: usize = 10;
}

/// Linear density of the Spire's string, kg/m (chosen so length 1 m at
/// mid tension sounds about G3).
const SPIRE_DENSITY: f32 = 0.000_74;
/// Orbital period, in beats, of a planet at radius 1.
const ORRERY_K: f32 = 4.0;
const REVERB_SEND: f32 = 0.35;

struct Slot {
    kind: u32,
    params: [f32; PARAMS],
    pulse: Pulse,
    // Spire
    pluck: Pluck,
    freq: f32,
    // Orrery
    bells: [Bell; PLANETS],
    planet_phase: [f64; PLANETS],
    planet_period: [f32; PLANETS],
    planet_freq: [f32; PLANETS],
    planet_flash: [f32; PLANETS],
    // Kettle
    bubbles: [Bubble; BUBBLES],
    next_bubble: usize,
    bands: [Svf; BANDS],
    band_lfo: f32,
    noise: Noise,
    drone_phase: f32,
    drone_freq: f32,
    coverage: f32,
    activity: f32,
    // Shared feedback for visuals
    env: f32,
    flash: f32,
    rolls: u64,
}

impl Slot {
    fn new(sr: f32, index: usize) -> Self {
        Slot {
            kind: kind::NONE,
            params: [0.0; PARAMS],
            pulse: Pulse::default(),
            pluck: Pluck::new(sr, 0x1234 + index as u32 * 7919),
            freq: 0.0,
            bells: [Bell::default(); PLANETS],
            planet_phase: [0.0; PLANETS],
            planet_period: [ORRERY_K; PLANETS],
            planet_freq: [0.0; PLANETS],
            planet_flash: [0.0; PLANETS],
            bubbles: [Bubble::default(); BUBBLES],
            next_bubble: 0,
            bands: [Svf::default(); BANDS],
            band_lfo: 0.0,
            noise: Noise::new(0xBEEF + index as u32 * 104_729),
            drone_phase: 0.0,
            drone_freq: 0.0,
            coverage: 0.0,
            activity: 0.0,
            env: 0.0,
            flash: 0.0,
            rolls: 0,
        }
    }

    /// Recompute derived quantities from params + Tuning. The Law lives here:
    /// one parameter drives the sound (and the snapshot drives the visuals).
    fn configure(&mut self, tuning: &Tuning, sr: f32) {
        let p = &self.params;
        match self.kind {
            kind::SPIRE => {
                let length = p[param::A].clamp(0.2, 2.0);
                let tension = p[param::B].clamp(0.0, 1.0);
                let harmonic = p[param::C].round().clamp(1.0, 8.0);
                let newtons = 40.0 * 8f32.powf(tension);
                let f0 = string::frequency(length, newtons, SPIRE_DENSITY);
                self.freq = tuning.snap((f0 * harmonic).min(6000.0));
                let t60 = (2.8 * (220.0 / self.freq).powf(0.35)).clamp(0.4, 6.0);
                self.pluck.set(self.freq, tension, t60);
            }
            kind::ORRERY => {
                for i in 0..PLANETS {
                    let r = p[param::A + i];
                    if r <= 0.0 {
                        continue;
                    }
                    let t = kepler::period(r, ORRERY_K);
                    self.planet_period[i] = if tuning.wild { t } else { kepler::quantize(t, 0.5) };
                    // Inner planets are faster and higher.
                    let deg = ((2.2 - r) * 5.0).round() as i32;
                    self.planet_freq[i] = tuning.degree(deg);
                }
            }
            kind::KETTLE => {
                for (b, deg) in self.bands.iter_mut().zip([0, 2, 4, 7]) {
                    b.set(tuning.degree(deg) * 2.0, 45.0, sr);
                }
                self.drone_freq = tuning.degree(0) * 0.5;
            }
            _ => {}
        }
    }

    fn roll(&mut self, seed: u64, index: usize) -> f32 {
        self.rolls += 1;
        rng::unit(rng::hash3(seed, index as u64, self.rolls))
    }

    fn bubble(&mut self, seed: u64, index: usize, energy: f32, tuning: &Tuning, sr: f32) {
        // 1–5 mm bubbles, pitch from the Minnaert law, then snapped to the Tuning.
        let radius_mm = 1.0 + 4.0 * self.roll(seed, index);
        let f = tuning.snap(bubble::frequency(radius_mm / 1000.0));
        self.bubbles[self.next_bubble].trigger(f, energy, sr);
        self.next_bubble = (self.next_bubble + 1) % BUBBLES;
        self.flash = 1.0;
    }

    fn poke(&mut self, strength: f32, seed: u64, index: usize, tuning: &Tuning, sr: f32) {
        let s = strength.clamp(0.0, 1.0);
        match self.kind {
            kind::SPIRE => {
                self.pluck.pluck(s);
                self.flash = 1.0;
            }
            kind::ORRERY => {
                for i in 0..PLANETS {
                    if self.params[param::A + i] > 0.0 {
                        self.bells[i].trigger(self.planet_freq[i], 0.25 * s, 2.5, sr);
                        self.planet_flash[i] = 1.0;
                    }
                }
                self.flash = 1.0;
            }
            kind::KETTLE => {
                self.bubble(seed, index, 0.35 * s, tuning, sr);
                self.bubble(seed, index, 0.2 * s, tuning, sr);
            }
            _ => {}
        }
    }

    #[inline]
    fn tick(&mut self, beat: f64, dbeat: f64, tuning: &Tuning, sr: f32, seed: u64, index: usize) -> f32 {
        let toy_seed = seed ^ (index as u64).wrapping_mul(0x100_0000_01B3);
        let y = match self.kind {
            kind::SPIRE => {
                if self.pulse.tick(beat, toy_seed).is_some() {
                    let e = 0.5 + 0.35 * self.roll(seed, index);
                    self.pluck.pluck(e);
                    self.flash = 1.0;
                }
                self.pluck.tick() * 0.8
            }
            kind::ORRERY => {
                let speed = self.params[param::SPEED].max(0.05) as f64;
                let mut sum = 0.0;
                for i in 0..PLANETS {
                    if self.params[param::A + i] > 0.0 {
                        self.planet_phase[i] += dbeat * speed / self.planet_period[i] as f64;
                        if self.planet_phase[i] >= 1.0 {
                            // A transit across the meridian rings the planet.
                            self.planet_phase[i] -= 1.0;
                            if self.pulse.enabled {
                                let r = self.params[param::A + i];
                                self.bells[i].trigger(self.planet_freq[i], 0.18 + 0.08 / r, 2.2, sr);
                                self.planet_flash[i] = 1.0;
                            }
                        }
                    }
                    sum += self.bells[i].tick();
                    self.planet_flash[i] *= 0.9997;
                }
                sum
            }
            kind::KETTLE => {
                self.coverage += (self.params[param::A] - self.coverage) * 0.0005;
                self.activity += (self.params[param::B] - self.activity) * 0.002;
                if self.pulse.tick(beat, toy_seed).is_some() {
                    let e = 0.12 + 0.3 * self.activity;
                    self.bubble(seed, index, e, tuning, sr);
                }
                self.band_lfo = (self.band_lfo + 0.06 / sr).fract();
                let n = self.noise.next();
                let mut sum = 0.0;
                for (b, band) in self.bands.iter_mut().enumerate() {
                    let lfo = 0.5 + 0.5 * (TAU * (self.band_lfo + b as f32 * 0.25)).sin();
                    sum += band.bandpass(n) * lfo;
                }
                let texture = sum * (0.4 + 2.5 * self.activity) * (0.3 + self.coverage);
                self.drone_phase = (self.drone_phase + self.drone_freq / sr).fract();
                let drone = (TAU * self.drone_phase).sin() * self.coverage * 0.18;
                let bubbles: f32 = self.bubbles.iter_mut().map(|b| b.tick(sr)).sum();
                texture + drone + bubbles
            }
            _ => 0.0,
        };
        self.env = y.abs().max(self.env * 0.9995);
        self.flash *= 0.9997;
        y
    }
}

pub struct Engine {
    pub clock: Clock,
    pub tuning: Tuning,
    pub master: f32,
    pub out: [f32; BLOCK * 2],
    pub snap: [f32; SNAP_LEN],
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
            out: [0.0; BLOCK * 2],
            snap: [0.0; SNAP_LEN],
            slots: (0..MAX_TOYS).map(|i| Slot::new(sr, i)).collect(),
            reverb: Reverb::new(sr),
            limiter: Limiter::new(sr),
            seed: 0xC05_A11C,
            sr,
        }
    }

    pub fn set_tuning(&mut self, root_midi: f32, scale: u32, wild: bool) {
        self.tuning = Tuning { root_hz: midi_to_hz(root_midi), scale: Scale::from_id(scale), wild };
        for s in &mut self.slots {
            s.configure(&self.tuning, self.sr);
        }
    }

    pub fn add_toy(&mut self, slot: usize, k: u32) {
        let Some(s) = self.slots.get_mut(slot) else { return };
        s.kind = k;
        s.params = [0.0; PARAMS];
        s.params[param::GAIN] = 1.0;
        s.params[param::SPEED] = 1.0;
        s.pulse = Pulse::default();
        s.planet_phase = [0.0; PLANETS];
        s.env = 0.0;
        s.flash = 0.0;
        s.configure(&self.tuning, self.sr);
    }

    pub fn remove_toy(&mut self, slot: usize) {
        if let Some(s) = self.slots.get_mut(slot) {
            s.kind = kind::NONE;
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
        s.configure(&self.tuning, self.sr);
        // A newly launched planet joins in phase with the beat grid.
        if s.kind == kind::ORRERY && (param::A..param::A + PLANETS).contains(&p) && was <= 0.0 && v > 0.0 {
            let i = p - param::A;
            let speed = s.params[param::SPEED].max(0.05) as f64;
            s.planet_phase[i] = (beat * speed / s.planet_period[i] as f64).fract();
        }
    }

    pub fn set_step(&mut self, slot: usize, step: usize, prob: f32) {
        if let Some(s) = self.slots.get_mut(slot) {
            if step < hypertoy_core::pulse::MAX_STEPS && prob.is_finite() {
                s.pulse.prob[step] = prob.clamp(0.0, 1.0);
            }
        }
    }

    pub fn poke(&mut self, slot: usize, strength: f32, _aux: f32) {
        let (seed, sr) = (self.seed, self.sr);
        if let Some(s) = self.slots.get_mut(slot) {
            s.poke(strength, seed, slot, &self.tuning, sr);
        }
    }

    pub fn process(&mut self, frames: usize) {
        let frames = frames.min(BLOCK);
        let dbeat = self.clock.beats_per_sample();
        for i in 0..frames {
            let beat = self.clock.beat;
            let (mut l, mut r, mut send) = (0.0f32, 0.0f32, 0.0f32);
            for (idx, s) in self.slots.iter_mut().enumerate() {
                if s.kind == kind::NONE {
                    continue;
                }
                let y = s.tick(beat, dbeat, &self.tuning, self.sr, self.seed, idx) * s.params[param::GAIN];
                // Equal-power pan.
                let theta = (s.params[param::PAN].clamp(-1.0, 1.0) + 1.0) * core::f32::consts::FRAC_PI_4;
                l += y * theta.cos();
                r += y * theta.sin();
                send += y;
            }
            let (rl, rr) = self.reverb.tick(send * REVERB_SEND);
            let (ol, or) = self.limiter.tick((l + rl) * self.master, (r + rr) * self.master);
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
            v[2] = s.freq;
            v[3] = s.pulse.current_step() as f32;
            v[4] = s.flash;
            v[5] = if s.pulse.enabled { 1.0 } else { 0.0 };
            for p in 0..PLANETS {
                v[6 + p] = (s.planet_phase[p] as f32) * TAU;
                v[10 + p] = s.planet_flash[p];
                v[14 + p] = s.planet_period[p];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(e: &mut Engine, seconds: f32) -> Vec<f32> {
        let blocks = (seconds * e.sr / BLOCK as f32) as usize;
        let mut out = Vec::with_capacity(blocks * BLOCK);
        for _ in 0..blocks {
            e.process(BLOCK);
            out.extend_from_slice(&e.out[..BLOCK]);
        }
        out
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
        let peak = out.iter().fold(0.0f32, |m, x| m.max(x.abs()));
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
}
