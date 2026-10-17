//! Patch voices: a small, allow-listed node graph (from the Node Forge, the
//! SDK or a ToyConfig) built into a fundsp [`Net`] at load time.
//!
//! The graph arrives as a flat list of numbers (`f32` words), compiled by the
//! playground's `audio/config.ts`; the layout is mirrored there.
//!
//! ```text
//! version(1) outputs(1|2) node_count
//! node:   op arg_count args... then one term list per input port of `op`
//! output: one term list per output channel
//! terms:  count, then per term: kind a b mul
//!         kind 0 = constant a; 1 = patch input a; 2 = node a, output port b
//! ```
//!
//! A port's value is the sum of its terms (each scaled by `mul`). Terms may
//! only reference *earlier* nodes, so every graph is acyclic; the one way to
//! loop is the `echo` node. Building validates everything first: a bad graph
//! is an error, never a panic (a panic would abort the audio worklet).

use crate::units::{BandNode, BellNode, BubbleNode, EchoNode, PluckNode};
use fundsp::prelude32::*;

/// Patch inputs, in order: law frequency, gate (held 0/1), trig (an impulse
/// carrying velocity), then the toy's first eight params.
pub const INPUT_FREQ: usize = 0;
pub const INPUT_GATE: usize = 1;
pub const INPUT_TRIG: usize = 2;
pub const INPUT_PARAM0: usize = 3;
pub const PATCH_PARAMS: usize = 8;
pub const NUM_INPUTS: usize = INPUT_PARAM0 + PATCH_PARAMS;

pub const MAX_NODES: usize = 64;
pub const MAX_ECHOES: usize = 2;
const MAX_UNITS: usize = 512;
const MAX_TERMS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PatchError {
    /// The program ended early.
    Truncated,
    BadVersion,
    BadOutputs,
    TooManyNodes,
    TooManyEchoes,
    UnknownOp { node: usize },
    BadArgs { node: usize },
    BadTerm { word: usize },
}

/// Ops by id. Mirrored in `apps/playground/src/audio/config.ts`.
pub mod op {
    pub const SINE: u32 = 1;
    pub const SAW: u32 = 2;
    pub const SQUARE: u32 = 3;
    pub const TRIANGLE: u32 = 4;
    pub const NOISE: u32 = 5;
    pub const PINK: u32 = 6;
    pub const ADSR: u32 = 7;
    pub const LOWPASS: u32 = 8;
    pub const HIGHPASS: u32 = 9;
    pub const BANDPASS: u32 = 10;
    pub const RESONATOR: u32 = 11;
    pub const MOOG: u32 = 12;
    pub const PLUCK: u32 = 13;
    pub const BELL: u32 = 14;
    pub const BUBBLE: u32 = 15;
    pub const BAND: u32 = 16;
    pub const ECHO: u32 = 17;
    pub const TANH: u32 = 18;
    pub const MUL: u32 = 19;
    pub const MIX: u32 = 20;
    pub const PAN: u32 = 21;
    pub const DCBLOCK: u32 = 22;
    pub const CRUSH: u32 = 23;
    pub const FOLLOW: u32 = 24;
}

/// (args, inputs, outputs) of an op, or None if unknown.
fn op_shape(op_id: u32) -> Option<(usize, usize, usize)> {
    use op::*;
    Some(match op_id {
        SINE | SAW | SQUARE | TRIANGLE => (0, 1, 1),
        NOISE | PINK => (0, 0, 1),
        ADSR => (4, 1, 1),
        LOWPASS | HIGHPASS | BANDPASS | RESONATOR | MOOG => (0, 3, 1),
        PLUCK | BELL | BAND | ECHO => (0, 3, 1),
        BUBBLE => (0, 2, 1),
        TANH | CRUSH | FOLLOW => (1, 1, 1),
        MUL => (0, 2, 1),
        MIX | DCBLOCK => (0, 1, 1),
        PAN => (0, 2, 2),
        _ => return None,
    })
}

fn unit(op_id: u32, args: &[f32], seed: u32) -> Option<Box<dyn AudioUnit>> {
    use op::*;
    let ok = |x: f32, lo: f32, hi: f32| (lo..=hi).contains(&x);
    Some(match op_id {
        SINE => Box::new(sine()),
        SAW => Box::new(saw()),
        SQUARE => Box::new(square()),
        TRIANGLE => Box::new(triangle()),
        NOISE => Box::new(noise()),
        PINK => Box::new(pink()),
        ADSR => {
            let [a, d, s, r] = [args[0], args[1], args[2], args[3]];
            if !(ok(a, 0.0, 10.0) && ok(d, 0.0, 10.0) && ok(s, 0.0, 1.0) && ok(r, 0.0, 20.0)) {
                return None;
            }
            Box::new(adsr_live(a.max(0.0005), d.max(0.0005), s, r.max(0.0005)))
        }
        LOWPASS => Box::new(lowpass()),
        HIGHPASS => Box::new(highpass()),
        BANDPASS => Box::new(bandpass()),
        RESONATOR => Box::new(resonator()),
        MOOG => Box::new(moog()),
        PLUCK => Box::new(An(PluckNode::new(seed))),
        BELL => Box::new(An(BellNode::new())),
        BUBBLE => Box::new(An(BubbleNode::new())),
        BAND => Box::new(An(BandNode::new())),
        ECHO => Box::new(An(EchoNode::new())),
        TANH if ok(args[0], 0.01, 100.0) => Box::new(shape(Tanh(args[0]))),
        CRUSH if ok(args[0], 1.0, 65_536.0) => Box::new(shape(Crush(args[0]))),
        FOLLOW if ok(args[0], 0.0001, 10.0) => Box::new(follow(args[0])),
        MUL => Box::new(pass() * pass()),
        MIX => Box::new(pass()),
        PAN => Box::new(panner()),
        DCBLOCK => Box::new(dcblock()),
        _ => return None,
    })
}

/// A built patch, ready to tick.
#[derive(Clone)]
pub struct Patch {
    net: Net,
    outputs: usize,
    out: [f32; 2],
}

impl Patch {
    pub fn build(words: &[f32], sample_rate: f32, seed: u64) -> Result<Patch, PatchError> {
        let mut r = Reader { w: words, i: 0 };
        if r.int()? != 1 {
            return Err(PatchError::BadVersion);
        }
        let outputs = r.int()? as usize;
        if !(1..=2).contains(&outputs) {
            return Err(PatchError::BadOutputs);
        }
        let n = r.int()? as usize;
        if n > MAX_NODES {
            return Err(PatchError::TooManyNodes);
        }
        let mut b = Builder { net: Net::new(NUM_INPUTS, outputs), nodes: Vec::with_capacity(n), units: 0 };
        let mut echoes = 0;
        for node in 0..n {
            let op_id = r.int()?;
            let (n_args, ins, outs) = op_shape(op_id).ok_or(PatchError::UnknownOp { node })?;
            if r.int()? as usize != n_args {
                return Err(PatchError::BadArgs { node });
            }
            let mut args = [0.0f32; 4];
            for a in args.iter_mut().take(n_args) {
                *a = r.num()?;
            }
            if op_id == op::ECHO {
                echoes += 1;
                if echoes > MAX_ECHOES {
                    return Err(PatchError::TooManyEchoes);
                }
            }
            let seed32 = (seed as u32) ^ (node as u32).wrapping_mul(0x9E37_79B9);
            let u = unit(op_id, &args, seed32).ok_or(PatchError::BadArgs { node })?;
            let id = b.push(u)?;
            for port in 0..ins {
                let terms = r.terms(node)?;
                b.wire(&terms, Sink::Node(id, port))?;
            }
            b.nodes.push((id, outs));
        }
        for ch in 0..outputs {
            let terms = r.terms(n)?;
            b.wire(&terms, Sink::Output(ch))?;
        }
        if r.i != words.len() {
            return Err(PatchError::BadTerm { word: r.i });
        }
        let mut net = b.net;
        net.set_sample_rate(sample_rate as f64);
        // Seed every noise source and oscillator phase: same seed, same sound.
        net.ping(false, AttoHash::new(seed));
        net.allocate();
        Ok(Patch { net, outputs, out: [0.0; 2] })
    }

    pub fn outputs(&self) -> usize {
        self.outputs
    }

    /// One sample. Mono patches return the same value on both sides.
    #[inline]
    pub fn tick(&mut self, input: &[f32; NUM_INPUTS]) -> (f32, f32) {
        self.net.tick(input, &mut self.out[..self.outputs]);
        let fix = |x: f32| if x.is_finite() { x } else { 0.0 };
        if self.outputs == 1 {
            let y = fix(self.out[0]);
            (y, y)
        } else {
            (fix(self.out[0]), fix(self.out[1]))
        }
    }
}

#[derive(Clone, Copy)]
struct Term {
    kind: u32,
    a: f32,
    b: u32,
    mul: f32,
}

struct Reader<'a> {
    w: &'a [f32],
    i: usize,
}

impl Reader<'_> {
    fn num(&mut self) -> Result<f32, PatchError> {
        let v = *self.w.get(self.i).ok_or(PatchError::Truncated)?;
        self.i += 1;
        if v.is_finite() {
            Ok(v)
        } else {
            Err(PatchError::BadTerm { word: self.i - 1 })
        }
    }

    fn int(&mut self) -> Result<u32, PatchError> {
        let v = self.num()?;
        if v < 0.0 || v.fract() != 0.0 || v > 1e6 {
            return Err(PatchError::BadTerm { word: self.i - 1 });
        }
        Ok(v as u32)
    }

    /// A term list for a port of `node` (terms may only use nodes before it).
    fn terms(&mut self, node: usize) -> Result<([Term; MAX_TERMS], usize), PatchError> {
        let at = self.i;
        let n = self.int()? as usize;
        if n > MAX_TERMS {
            return Err(PatchError::BadTerm { word: at });
        }
        let mut out = [Term { kind: 0, a: 0.0, b: 0, mul: 0.0 }; MAX_TERMS];
        for t in out.iter_mut().take(n) {
            let word = self.i;
            let kind = self.int()?;
            let a = self.num()?;
            let b = self.int()?;
            let mul = self.num()?;
            let valid = match kind {
                0 => true,
                1 => a >= 0.0 && a.fract() == 0.0 && (a as usize) < NUM_INPUTS,
                2 => a >= 0.0 && a.fract() == 0.0 && (a as usize) < node,
                _ => false,
            };
            if !valid {
                return Err(PatchError::BadTerm { word });
            }
            *t = Term { kind, a, b, mul };
        }
        Ok((out, n))
    }
}

#[derive(Clone, Copy)]
enum Sink {
    Node(NodeId, usize),
    Output(usize),
}

struct Builder {
    net: Net,
    /// (unit id, output count) per user node.
    nodes: Vec<(NodeId, usize)>,
    units: usize,
}

impl Builder {
    fn push(&mut self, u: Box<dyn AudioUnit>) -> Result<NodeId, PatchError> {
        self.units += 1;
        if self.units > MAX_UNITS {
            return Err(PatchError::TooManyNodes);
        }
        Ok(self.net.push(u))
    }

    /// One scaled term as a (node, port) source; `None` means "global input".
    fn source(&mut self, t: &Term) -> Result<(NodeId, usize), PatchError> {
        let (src, port) = match t.kind {
            0 => return Ok((self.push(Box::new(dc(t.a * t.mul)))?, 0)),
            1 => {
                let id = self.push(Box::new(pass()))?;
                self.net.connect_input(t.a as usize, id, 0);
                (id, 0)
            }
            _ => {
                let (id, outs) = self.nodes[t.a as usize];
                if t.b as usize >= outs {
                    return Err(PatchError::BadTerm { word: 0 });
                }
                (id, t.b as usize)
            }
        };
        if t.mul == 1.0 {
            return Ok((src, port));
        }
        let m = self.push(Box::new(mul(t.mul)))?;
        self.net.connect(src, port, m, 0);
        Ok((m, 0))
    }

    fn wire(&mut self, terms: &([Term; MAX_TERMS], usize), sink: Sink) -> Result<(), PatchError> {
        let (terms, n) = (&terms.0[..terms.1], terms.1);
        if n == 0 {
            // Unconnected ports read zero; outputs need an explicit zero.
            if let Sink::Output(ch) = sink {
                let z = self.push(Box::new(zero()))?;
                self.net.connect_output(z, 0, ch);
            }
            return Ok(());
        }
        let mut acc = self.source(&terms[0])?;
        for t in &terms[1..] {
            let s = self.source(t)?;
            let add = self.push(Box::new(pass() + pass()))?;
            self.net.connect(acc.0, acc.1, add, 0);
            self.net.connect(s.0, s.1, add, 1);
            acc = (add, 0);
        }
        match sink {
            Sink::Node(id, port) => self.net.connect(acc.0, acc.1, id, port),
            Sink::Output(ch) => self.net.connect_output(acc.0, acc.1, ch),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tiny assembler for tests: terms are (kind, a, b, mul).
    fn prog(outputs: u32, nodes: &[(u32, &[f32], &[&[(u32, f32, u32, f32)]])], outs: &[&[(u32, f32, u32, f32)]]) -> Vec<f32> {
        let mut w = vec![1.0, outputs as f32, nodes.len() as f32];
        let terms = |w: &mut Vec<f32>, ts: &[(u32, f32, u32, f32)]| {
            w.push(ts.len() as f32);
            for &(k, a, b, m) in ts {
                w.extend([k as f32, a, b as f32, m]);
            }
        };
        for (op, args, ports) in nodes {
            w.push(*op as f32);
            w.push(args.len() as f32);
            w.extend_from_slice(args);
            for p in *ports {
                terms(&mut w, p);
            }
        }
        for o in outs {
            terms(&mut w, o);
        }
        w
    }

    fn render(p: &mut Patch, input: [f32; NUM_INPUTS], n: usize) -> Vec<f32> {
        (0..n).map(|_| p.tick(&input).0).collect()
    }

    fn zero_cross_hz(s: &[f32], sr: f32) -> f32 {
        s.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count() as f32 * sr / s.len() as f32
    }

    /// Pitch by autocorrelation (robust to strong overtones, unlike zero crossings).
    fn autocorr_hz(s: &[f32], sr: f32) -> f32 {
        let corr = |lag: usize| s.iter().zip(&s[lag..]).map(|(a, b)| a * b).sum::<f32>();
        let (lo, hi) = ((sr / 1000.0) as usize, (sr / 60.0) as usize);
        let best = (lo..hi).max_by(|&a, &b| corr(a).total_cmp(&corr(b))).unwrap();
        sr / best as f32
    }

    #[test]
    fn sine_follows_the_freq_input_with_scaling() {
        // sine(freq * 2) * 0.5
        let w = prog(1, &[(op::SINE, &[], &[&[(1, 0.0, 0, 2.0)]])], &[&[(2, 0.0, 0, 0.5)]]);
        let mut p = Patch::build(&w, 48_000.0, 1).unwrap();
        let mut input = [0.0; NUM_INPUTS];
        input[INPUT_FREQ] = 220.0;
        let out = render(&mut p, input, 48_000);
        assert!((zero_cross_hz(&out, 48_000.0) - 440.0).abs() < 2.0);
        let peak = out.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!((peak - 0.5).abs() < 0.01);
    }

    #[test]
    fn wrapped_pluck_rings_on_a_trigger() {
        // pluck(trig, freq, 0.2): a dark string, so zero crossings track the fundamental.
        let w = prog(
            1,
            &[(op::PLUCK, &[], &[&[(1, 2.0, 0, 1.0)], &[(1, 0.0, 0, 1.0)], &[(0, 0.2, 0, 1.0)]])],
            &[&[(2, 0.0, 0, 1.0)]],
        );
        let mut p = Patch::build(&w, 48_000.0, 7).unwrap();
        let mut input = [0.0; NUM_INPUTS];
        input[INPUT_FREQ] = 220.0;
        assert!(render(&mut p, input, 1000).iter().all(|&x| x.abs() < 1e-6));
        input[INPUT_TRIG] = 0.8;
        p.tick(&input);
        input[INPUT_TRIG] = 0.0;
        let out = render(&mut p, input, 36_000);
        assert!(out.iter().fold(0.0f32, |m, x| m.max(x.abs())) > 0.1);
        let hz = autocorr_hz(&out[12_000..16_000], 48_000.0);
        assert!((hz - 220.0).abs() < 8.0, "{hz}");
    }

    #[test]
    fn adsr_gates_and_sums_mix() {
        // (sine(freq) + noise*0) * adsr(gate), summing two terms into mul's first port.
        let w = prog(
            1,
            &[
                (op::SINE, &[], &[&[(1, 0.0, 0, 1.0)]]),
                (op::NOISE, &[], &[]),
                (op::ADSR, &[0.001, 0.05, 0.5, 0.05], &[&[(1, 1.0, 0, 1.0)]]),
                (op::MUL, &[], &[&[(2, 0.0, 0, 1.0), (2, 1.0, 0, 0.0)], &[(2, 2.0, 0, 1.0)]]),
            ],
            &[&[(2, 3.0, 0, 1.0)]],
        );
        let mut p = Patch::build(&w, 48_000.0, 3).unwrap();
        let mut input = [0.0; NUM_INPUTS];
        input[INPUT_FREQ] = 300.0;
        assert!(render(&mut p, input, 2000).iter().all(|&x| x.abs() < 1e-4));
        input[INPUT_GATE] = 1.0;
        let held = render(&mut p, input, 9600);
        let peak = held[4800..].iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!((peak - 0.5).abs() < 0.05, "sustain peak {peak}");
        input[INPUT_GATE] = 0.0;
        let tail = render(&mut p, input, 24_000);
        assert!(tail[20_000..].iter().all(|&x| x.abs() < 1e-3));
    }

    #[test]
    fn stereo_pan_and_determinism() {
        let w = prog(
            2,
            &[
                (op::NOISE, &[], &[]),
                (op::PAN, &[], &[&[(2, 0.0, 0, 0.3)], &[(0, -1.0, 0, 1.0)]]),
            ],
            &[&[(2, 1.0, 0, 1.0)], &[(2, 1.0, 1, 1.0)]],
        );
        let run = |seed| {
            let mut p = Patch::build(&w, 48_000.0, seed).unwrap();
            (0..512).map(|_| p.tick(&[0.0; NUM_INPUTS])).collect::<Vec<_>>()
        };
        let a = run(5);
        assert_eq!(a, run(5));
        assert_ne!(a, run(6));
        // Hard left: the right channel is (near) silent.
        assert!(a.iter().all(|&(_, r)| r.abs() < 1e-3));
        assert!(a.iter().any(|&(l, _)| l.abs() > 0.05));
    }

    #[test]
    fn rejects_bad_programs_without_panicking() {
        let sine = |terms: &[(u32, f32, u32, f32)]| prog(1, &[(op::SINE, &[], &[terms])], &[&[(2, 0.0, 0, 1.0)]]);
        let err = |w: &[f32]| Patch::build(w, 48_000.0, 0).err().unwrap();
        assert_eq!(err(&[]), PatchError::Truncated);
        assert_eq!(err(&[2.0, 1.0, 0.0]), PatchError::BadVersion);
        assert_eq!(err(&[1.0, 3.0, 0.0]), PatchError::BadOutputs);
        assert_eq!(err(&[1.0, 1.0, 65.0]), PatchError::TooManyNodes);
        assert_eq!(err(&[1.0, 1.0, 1.0, 99.0, 0.0]), PatchError::UnknownOp { node: 0 });
        // Forward or self reference.
        assert!(matches!(err(&sine(&[(2, 0.0, 0, 1.0)])), PatchError::BadTerm { .. }));
        // Input index out of range.
        assert!(matches!(err(&sine(&[(1, 11.0, 0, 1.0)])), PatchError::BadTerm { .. }));
        // NaN in a term.
        assert!(matches!(err(&sine(&[(0, f32::NAN, 0, 1.0)])), PatchError::BadTerm { .. }));
        // Output port that doesn't exist.
        let w = prog(1, &[(op::SINE, &[], &[&[]])], &[&[(2, 0.0, 1, 1.0)]]);
        assert!(matches!(err(&w), PatchError::BadTerm { .. }));
        // ADSR args out of range.
        let w = prog(1, &[(op::ADSR, &[0.0, 0.0, 2.0, 0.0], &[&[]])], &[&[(2, 0.0, 0, 1.0)]]);
        assert_eq!(err(&w), PatchError::BadArgs { node: 0 });
        // Three echoes.
        let e: (u32, &[f32], &[&[(u32, f32, u32, f32)]]) = (op::ECHO, &[], &[&[], &[], &[]]);
        let w = prog(1, &[e, e, e], &[&[]]);
        assert_eq!(err(&w), PatchError::TooManyEchoes);
        // Trailing junk.
        let mut w = sine(&[]);
        w.push(0.0);
        assert!(matches!(err(&w), PatchError::BadTerm { .. }));
    }

    /// Seeded xorshift so fuzz failures reproduce.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % core::cmp::max(n, 1)
        }
        fn pick(&mut self, xs: &[f32]) -> f32 {
            xs[self.below(xs.len() as u64) as usize]
        }
    }

    /// Numbers that tend to break things.
    const NASTY: [f32; 14] = [0.0, 1.0, -1.0, 0.5, 2.0, 7.0, 64.0, 1e6, -1e6, 1e30, f32::NAN, f32::INFINITY, 1.5, 12_000.0];

    /// A mostly well-formed program with random ops, args, terms and mistakes.
    fn plausible(r: &mut Rng) -> Vec<f32> {
        let n = r.below(10) as usize;
        let mut w = vec![1.0, (1 + r.below(2)) as f32, n as f32];
        let term = |r: &mut Rng, w: &mut Vec<f32>, node: usize| {
            // Node references only exist from the second node on.
            let k = r.below(if node == 0 { 2 } else { 3 });
            // Now and then, one past the end: an out-of-range input or a self-reference.
            let past = (r.below(12) == 0) as u64;
            let a = match k {
                1 => r.below(NUM_INPUTS as u64 + past) as f32,
                2 => r.below(node as u64 + past) as f32,
                _ => if r.below(6) == 0 { r.pick(&NASTY) } else { r.pick(&[0.0, 1.0, 440.0, 1e6, -3.0]) },
            };
            // Mostly valid scales and ports, with a few bad ones mixed in.
            let mul = if r.below(8) == 0 { r.pick(&NASTY) } else { r.pick(&[1.0, 0.5, -2.0, 100.0, 1e6]) };
            let port = if r.below(8) == 0 { 2 } else { 0 };
            w.extend([k as f32, a, port as f32, mul]);
        };
        for node in 0..n {
            let span = if r.below(20) == 0 { 30 } else { 24 }; // now and then, an unknown op
            let op_id = 1 + r.below(span) as u32;
            let (args, ins, _) = op_shape(op_id).unwrap_or((0, 0, 0));
            w.push(op_id as f32);
            w.push(args as f32);
            for _ in 0..args {
                w.push(if r.below(5) > 0 { (1 + r.below(4)) as f32 * 0.1 } else { r.pick(&NASTY) });
            }
            for _ in 0..ins {
                let terms = r.below(4) as usize;
                w.push(terms as f32);
                for _ in 0..terms {
                    term(r, &mut w, node);
                }
            }
        }
        for _ in 0..2 {
            let terms = r.below(3) as usize;
            w.push(terms as f32);
            for _ in 0..terms {
                term(r, &mut w, n);
            }
        }
        // Sometimes truncate or corrupt a word.
        match r.below(10) {
            0 if !w.is_empty() => {
                let cut = r.below(w.len() as u64) as usize;
                w.truncate(cut);
            }
            1 if !w.is_empty() => {
                let at = r.below(w.len() as u64) as usize;
                w[at] = r.pick(&NASTY);
            }
            _ => {}
        }
        w
    }

    #[test]
    fn fuzz_build_never_panics_and_output_stays_finite() {
        let mut r = Rng(0x5EED_CAFE);
        let (mut built, mut tried) = (0, 0);
        for case in 0..4000 {
            let w: Vec<f32> = if case % 4 == 0 {
                (0..r.below(40)).map(|_| r.pick(&NASTY)).collect()
            } else {
                plausible(&mut r)
            };
            tried += 1;
            let Ok(mut p) = Patch::build(&w, 48_000.0, case) else { continue };
            built += 1;
            let mut input = [0.0f32; NUM_INPUTS];
            for i in 0..256 {
                for x in input.iter_mut() {
                    *x = if i % 64 == 0 { r.pick(&NASTY) } else { *x };
                }
                let (a, b) = p.tick(&input);
                assert!(a.is_finite() && b.is_finite(), "case {case}: {w:?}");
            }
        }
        // The generator must actually reach the builder, not just its validation.
        assert!(built > tried / 10, "only {built} of {tried} programs built");
    }
}
