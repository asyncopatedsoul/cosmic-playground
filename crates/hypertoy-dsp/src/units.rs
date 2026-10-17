//! Our hand-tuned nodes wrapped as fundsp `AudioNode`s, so patches can mix
//! them freely with fundsp's own. Triggers are signals: a rising edge on the
//! `trig` input (from <= 0 to > 0) strikes the node with that value as energy.

use crate::{Bell, Bubble, Pluck, Svf};
use fundsp::prelude32::*;

#[derive(Clone, Copy, Default)]
struct Edge(f32);

impl Edge {
    /// The new value if this sample is a rising edge.
    #[inline]
    fn rise(&mut self, x: f32) -> Option<f32> {
        let up = self.0 <= 0.0 && x > 0.0;
        self.0 = x;
        up.then_some(x.min(1.0))
    }
}

/// Karplus-Strong string. Inputs: trig, freq (Hz), brightness (0..1). Output: audio.
#[derive(Clone)]
pub struct PluckNode {
    pluck: Pluck,
    edge: Edge,
    freq: f32,
    bright: f32,
    seed: u32,
    sr: f32,
}

impl PluckNode {
    pub fn new(seed: u32) -> Self {
        let sr = 44_100.0;
        PluckNode { pluck: Pluck::new(sr, seed), edge: Edge(0.0), freq: 0.0, bright: -1.0, seed, sr }
    }
}

impl AudioNode for PluckNode {
    const ID: u64 = 0x4854_0001;
    type Inputs = U3;
    type Outputs = U1;

    fn reset(&mut self) {
        self.pluck = Pluck::new(self.sr, self.seed);
        self.freq = 0.0;
    }

    fn set_sample_rate(&mut self, sample_rate: f64) {
        self.sr = sample_rate as f32;
        self.reset();
    }

    #[inline]
    fn tick(&mut self, input: &Frame<f32, U3>) -> Frame<f32, U1> {
        let (freq, bright) = (input[1].clamp(20.0, 8000.0), input[2].clamp(0.0, 1.0));
        // Re-tuning costs a powf, so only do it when something moved.
        if (freq - self.freq).abs() > 0.01 || (bright - self.bright).abs() > 1e-3 {
            self.freq = freq;
            self.bright = bright;
            let t60 = (2.8 * (220.0 / freq).powf(0.35)).clamp(0.4, 6.0);
            self.pluck.set(freq, bright, t60);
        }
        if let Some(e) = self.edge.rise(input[0]) {
            self.pluck.pluck(e);
        }
        [self.pluck.tick()].into()
    }
}

/// FM bell. Inputs: trig, freq (Hz), decay (s). Output: audio.
#[derive(Clone, Default)]
pub struct BellNode {
    bell: Bell,
    edge: Edge,
    sr: f32,
}

impl BellNode {
    pub fn new() -> Self {
        BellNode { sr: 44_100.0, ..Default::default() }
    }
}

impl AudioNode for BellNode {
    const ID: u64 = 0x4854_0002;
    type Inputs = U3;
    type Outputs = U1;

    fn reset(&mut self) {
        self.bell = Bell::default();
    }

    fn set_sample_rate(&mut self, sample_rate: f64) {
        self.sr = sample_rate as f32;
    }

    #[inline]
    fn tick(&mut self, input: &Frame<f32, U3>) -> Frame<f32, U1> {
        if let Some(e) = self.edge.rise(input[0]) {
            self.bell.trigger(input[1].clamp(20.0, 8000.0), 0.5 * e, input[2].clamp(0.05, 10.0), self.sr);
        }
        [self.bell.tick()].into()
    }
}

/// Minnaert bubble chirp. Inputs: trig, freq (Hz). Output: audio.
#[derive(Clone, Default)]
pub struct BubbleNode {
    bubble: Bubble,
    edge: Edge,
    sr: f32,
}

impl BubbleNode {
    pub fn new() -> Self {
        BubbleNode { sr: 44_100.0, ..Default::default() }
    }
}

impl AudioNode for BubbleNode {
    const ID: u64 = 0x4854_0003;
    type Inputs = U2;
    type Outputs = U1;

    fn reset(&mut self) {
        self.bubble = Bubble::default();
    }

    fn set_sample_rate(&mut self, sample_rate: f64) {
        self.sr = sample_rate as f32;
    }

    #[inline]
    fn tick(&mut self, input: &Frame<f32, U2>) -> Frame<f32, U1> {
        if let Some(e) = self.edge.rise(input[0]) {
            self.bubble.trigger(input[1].clamp(20.0, 8000.0), 0.5 * e, self.sr);
        }
        [self.bubble.tick(self.sr)].into()
    }
}

/// Our zero-delay-feedback bandpass. Inputs: audio, freq (Hz), Q. Output: audio.
#[derive(Clone, Default)]
pub struct BandNode {
    svf: Svf,
    freq: f32,
    q: f32,
    sr: f32,
}

impl BandNode {
    pub fn new() -> Self {
        BandNode { sr: 44_100.0, ..Default::default() }
    }
}

impl AudioNode for BandNode {
    const ID: u64 = 0x4854_0004;
    type Inputs = U3;
    type Outputs = U1;

    fn reset(&mut self) {
        self.svf = Svf::default();
        self.freq = 0.0;
    }

    fn set_sample_rate(&mut self, sample_rate: f64) {
        self.sr = sample_rate as f32;
        self.reset();
    }

    #[inline]
    fn tick(&mut self, input: &Frame<f32, U3>) -> Frame<f32, U1> {
        let (f, q) = (input[1].clamp(20.0, self.sr * 0.45), input[2].clamp(0.1, 100.0));
        if (f - self.freq).abs() > 0.01 || (q - self.q).abs() > 1e-3 {
            self.freq = f;
            self.q = q;
            self.svf.set(f, q, self.sr);
        }
        [self.svf.bandpass(input[0])].into()
    }
}

/// Longest echo, in seconds.
pub const ECHO_MAX_S: f32 = 2.0;

/// Feedback echo: the one way a patch may loop. Inputs: audio, time (s),
/// feedback (0..0.95). Output: audio (dry + wet).
#[derive(Clone)]
pub struct EchoNode {
    buf: Vec<f32>,
    w: usize,
    sr: f32,
}

impl EchoNode {
    pub fn new() -> Self {
        let mut e = EchoNode { buf: Vec::new(), w: 0, sr: 44_100.0 };
        e.alloc();
        e
    }

    fn alloc(&mut self) {
        self.buf = vec![0.0; (ECHO_MAX_S * self.sr) as usize + 2];
        self.w = 0;
    }
}

impl Default for EchoNode {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioNode for EchoNode {
    const ID: u64 = 0x4854_0005;
    type Inputs = U3;
    type Outputs = U1;

    fn reset(&mut self) {
        self.buf.iter_mut().for_each(|x| *x = 0.0);
    }

    fn set_sample_rate(&mut self, sample_rate: f64) {
        if sample_rate as f32 != self.sr {
            self.sr = sample_rate as f32;
            self.alloc();
        }
    }

    #[inline]
    fn tick(&mut self, input: &Frame<f32, U3>) -> Frame<f32, U1> {
        let len = self.buf.len();
        let d = (input[1].clamp(0.001, ECHO_MAX_S) * self.sr) as usize;
        let wet = self.buf[(self.w + len - core::cmp::min(d, len - 1)) % len];
        let fb = input[2].clamp(0.0, 0.95);
        self.buf[self.w] = input[0] + wet * fb + 1e-18;
        self.w = (self.w + 1) % len;
        [input[0] + wet * 0.5].into()
    }
}

