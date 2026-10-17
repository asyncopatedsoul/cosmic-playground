//! Pattern mini-notation for Pulses, in the Tidal/Strudel style.
//!
//! Written from the notation's documented behaviour, not from Strudel's
//! (AGPL) source: pattern *text* is portable both ways, the code is ours.
//!
//! ```text
//! x . x [x x]          sequence; `.` or `~` is a rest; [ ] subdivides
//! <x [x x]>            alternate: one child per cycle
//! x*2   [x x]/2        faster / slower
//! x?    x?0.3          sometimes (50%, or the given chance)
//! x(3,8)  x(3,8,2)     Euclidean rhythm (with rotation)
//! {x . x}%4            polymeter: step through children, 4 steps per cycle
//! x!3                  replicate: same as `x x x`
//! x:0.4  X             velocity (X is an accent); x is 0.8
//! 0 2 <4 7> -1         numbers are scale degrees (a pitch value per event)
//! ```
//!
//! A [`Pattern`] is parsed once (allocates); [`Pattern::query`] fills a fixed
//! buffer with one cycle's events and never allocates, so it is safe to call
//! from the audio thread at cycle boundaries.

pub const MAX_EVENTS: usize = 64;
const MAX_NODES: usize = 256;
const MAX_DEPTH: usize = 16;
const EPS: f64 = 1e-9;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Event {
    /// Onset in cycles (absolute).
    pub onset: f64,
    pub vel: f32,
    /// Scale degree, or NaN for a plain trigger.
    pub value: f32,
    /// Probability that the event plays (rolled by the Pulse, deterministically).
    pub chance: f32,
}

impl Event {
    pub const EMPTY: Event = Event { onset: 0.0, vel: 0.0, value: f32::NAN, chance: 1.0 };
}

#[derive(Clone, Debug)]
enum Node {
    Atom { vel: f32, value: f32 },
    Rest,
    Seq(Vec<usize>),
    Alt(Vec<usize>),
    Poly(Vec<usize>, usize),
    Fast(usize, f64),
    Chance(usize, f32),
}

#[derive(Clone, Debug)]
pub struct Pattern {
    nodes: Vec<Node>,
    root: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParseError {
    /// Byte offset where parsing failed.
    pub at: usize,
    pub kind: ErrorKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    Unexpected,
    Unclosed,
    BadNumber,
    TooBig,
    Empty,
}

impl Pattern {
    pub fn parse(src: &str) -> Result<Pattern, ParseError> {
        let mut p = Parser { s: src.as_bytes(), i: 0, nodes: Vec::new(), depth: 0 };
        let root = p.seq(b'\0')?;
        p.ws();
        if p.i < p.s.len() {
            return Err(p.err(ErrorKind::Unexpected));
        }
        if let Node::Seq(c) = &p.nodes[root] {
            if c.is_empty() {
                return Err(ParseError { at: 0, kind: ErrorKind::Empty });
            }
        }
        Ok(Pattern { nodes: p.nodes, root })
    }

    /// Events with onsets in `[cycle, cycle + 1)`, sorted by onset. Returns the count
    /// written to `out` (extra events past [`MAX_EVENTS`] are dropped).
    pub fn query(&self, cycle: i64, out: &mut [Event; MAX_EVENTS]) -> usize {
        let mut n = 0;
        let c = cycle as f64;
        self.q(self.root, c, c + 1.0, 1.0, 0.0, 1.0, out, &mut n);
        out[..n].sort_by(|a, b| a.onset.partial_cmp(&b.onset).unwrap_or(core::cmp::Ordering::Equal));
        n
    }

    /// Query `node` over its local window [a, b). Local time t maps to global
    /// time `t * s + o`.
    #[allow(clippy::too_many_arguments)]
    fn q(&self, node: usize, a: f64, b: f64, s: f64, o: f64, chance: f32, out: &mut [Event; MAX_EVENTS], n: &mut usize) {
        if b - a <= EPS || *n >= MAX_EVENTS {
            return;
        }
        match &self.nodes[node] {
            Node::Rest => {}
            Node::Atom { vel, value } => {
                let mut k = (a - EPS).ceil();
                while k < b - EPS && *n < MAX_EVENTS {
                    out[*n] = Event { onset: k * s + o, vel: *vel, value: *value, chance };
                    *n += 1;
                    k += 1.0;
                }
            }
            Node::Seq(kids) => {
                let len = kids.len() as f64;
                self.each_cycle(a, b, |c| {
                    for (i, &kid) in kids.iter().enumerate() {
                        let start = c + i as f64 / len;
                        self.segment(kid, a, b, start, 1.0 / len, c, s, o, chance, out, n);
                    }
                });
            }
            Node::Poly(kids, steps) => {
                let (len, m) = (kids.len() as i64, *steps as i64);
                self.each_cycle(a, b, |c| {
                    for j in 0..m {
                        let k = c as i64 * m + j;
                        let kid = kids[k.rem_euclid(len) as usize];
                        let start = c + j as f64 / m as f64;
                        self.segment(kid, a, b, start, 1.0 / m as f64, k.div_euclid(len) as f64, s, o, chance, out, n);
                    }
                });
            }
            Node::Alt(kids) => {
                let len = kids.len() as i64;
                self.each_cycle(a, b, |c| {
                    let ci = c as i64;
                    let kid = kids[ci.rem_euclid(len) as usize];
                    let d = ci.div_euclid(len) as f64;
                    // Each child keeps its own cycle count, so alternations nest.
                    let (lo, hi) = (a.max(c), b.min(c + 1.0));
                    self.q(kid, lo - c + d, hi - c + d, s, o + s * (c - d), chance, out, n);
                });
            }
            Node::Fast(kid, f) => self.q(*kid, a * f, b * f, s / f, o, chance, out, n),
            Node::Chance(kid, p) => self.q(*kid, a, b, s, o, chance * p, out, n),
        }
    }

    fn each_cycle(&self, a: f64, b: f64, mut f: impl FnMut(f64)) {
        let mut c = (a + EPS).floor();
        while c < b - EPS {
            f(c);
            c += 1.0;
        }
    }

    /// Query `kid` squeezed into [start, start + width) of the parent, giving it
    /// local cycle `kc` there.
    #[allow(clippy::too_many_arguments)]
    fn segment(
        &self,
        kid: usize,
        a: f64,
        b: f64,
        start: f64,
        width: f64,
        kc: f64,
        s: f64,
        o: f64,
        chance: f32,
        out: &mut [Event; MAX_EVENTS],
        n: &mut usize,
    ) {
        let (lo, hi) = (a.max(start), b.min(start + width));
        if hi - lo <= EPS {
            return;
        }
        // Parent time t = start + (child_t - kc) * width.
        let to_kid = |t: f64| kc + (t - start) / width;
        self.q(kid, to_kid(lo), to_kid(hi), s * width, o + s * (start - kc * width), chance, out, n);
    }
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    nodes: Vec<Node>,
    depth: usize,
}

impl Parser<'_> {
    fn err(&self, kind: ErrorKind) -> ParseError {
        ParseError { at: self.i, kind }
    }

    fn push(&mut self, n: Node) -> Result<usize, ParseError> {
        if self.nodes.len() >= MAX_NODES {
            return Err(self.err(ErrorKind::TooBig));
        }
        self.nodes.push(n);
        Ok(self.nodes.len() - 1)
    }

    fn ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }

    fn peek(&self) -> u8 {
        *self.s.get(self.i).unwrap_or(&b'\0')
    }

    /// Terms until `close` (or end of input for `\0`), as one Seq node.
    fn seq(&mut self, close: u8) -> Result<usize, ParseError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.err(ErrorKind::TooBig));
        }
        let mut kids = Vec::new();
        loop {
            self.ws();
            let c = self.peek();
            if c == close && close != b'\0' {
                break;
            }
            if c == b'\0' {
                if close != b'\0' {
                    return Err(self.err(ErrorKind::Unclosed));
                }
                break;
            }
            if matches!(c, b']' | b'>' | b'}') {
                return Err(self.err(ErrorKind::Unexpected));
            }
            let (term, times) = self.term()?;
            for _ in 0..times {
                kids.push(term);
            }
        }
        self.depth -= 1;
        self.push(Node::Seq(kids))
    }

    /// One term with its modifiers. Returns the node and how many times to replicate it.
    fn term(&mut self) -> Result<(usize, usize), ParseError> {
        let start = self.i;
        let mut node = match self.peek() {
            b'[' => {
                self.i += 1;
                let n = self.seq(b']')?;
                self.i += 1;
                n
            }
            b'<' => {
                self.i += 1;
                let n = self.seq(b'>')?;
                self.i += 1;
                let Node::Seq(kids) = self.nodes[n].clone() else { unreachable!() };
                if kids.is_empty() {
                    return Err(ParseError { at: start, kind: ErrorKind::Empty });
                }
                self.nodes[n] = Node::Alt(kids);
                n
            }
            b'{' => {
                self.i += 1;
                let n = self.seq(b'}')?;
                self.i += 1;
                let Node::Seq(kids) = self.nodes[n].clone() else { unreachable!() };
                if kids.is_empty() {
                    return Err(ParseError { at: start, kind: ErrorKind::Empty });
                }
                let steps = if self.peek() == b'%' {
                    self.i += 1;
                    self.int(1, 64)?
                } else {
                    kids.len()
                };
                self.nodes[n] = Node::Poly(kids, steps);
                n
            }
            b'.' | b'~' => {
                self.i += 1;
                self.push(Node::Rest)?
            }
            b'x' => {
                self.i += 1;
                self.push(Node::Atom { vel: 0.8, value: f32::NAN })?
            }
            b'X' => {
                self.i += 1;
                self.push(Node::Atom { vel: 1.0, value: f32::NAN })?
            }
            c if c == b'-' || c.is_ascii_digit() => {
                let v = self.number()?;
                self.push(Node::Atom { vel: 0.8, value: v as f32 })?
            }
            _ => return Err(self.err(ErrorKind::Unexpected)),
        };
        let mut times = 1;
        loop {
            match self.peek() {
                b'*' => {
                    self.i += 1;
                    let f = self.positive()?;
                    node = self.push(Node::Fast(node, f))?;
                }
                b'/' => {
                    self.i += 1;
                    let f = self.positive()?;
                    node = self.push(Node::Fast(node, 1.0 / f))?;
                }
                b'?' => {
                    self.i += 1;
                    let c = self.peek();
                    let p = if c == b'.' || c.is_ascii_digit() { self.number()? } else { 0.5 };
                    if !(0.0..=1.0).contains(&p) {
                        return Err(self.err(ErrorKind::BadNumber));
                    }
                    node = self.push(Node::Chance(node, p as f32))?;
                }
                b':' => {
                    self.i += 1;
                    let v = self.number()?;
                    match &mut self.nodes[node] {
                        Node::Atom { vel, .. } if (0.0..=1.0).contains(&v) => *vel = v as f32,
                        _ => return Err(self.err(ErrorKind::BadNumber)),
                    }
                }
                b'!' => {
                    self.i += 1;
                    times = self.int(1, 32)?;
                }
                b'(' => {
                    self.i += 1;
                    node = self.euclid(node)?;
                }
                _ => break,
            }
        }
        Ok((node, times))
    }

    fn euclid(&mut self, node: usize) -> Result<usize, ParseError> {
        self.ws();
        let hits = self.int(0, 64)?;
        self.ws();
        self.expect(b',')?;
        self.ws();
        let steps = self.int(1, 64)?;
        self.ws();
        let mut rot = 0;
        if self.peek() == b',' {
            self.i += 1;
            self.ws();
            rot = self.int(0, 64)?;
            self.ws();
        }
        self.expect(b')')?;
        let pattern = crate::pulse::euclid_n(hits.min(steps), steps);
        let rest = self.push(Node::Rest)?;
        let kids = (0..steps).map(|i| if pattern((i + rot) % steps) { node } else { rest }).collect();
        self.push(Node::Seq(kids))
    }

    fn expect(&mut self, c: u8) -> Result<(), ParseError> {
        if self.peek() != c {
            return Err(self.err(ErrorKind::Unexpected));
        }
        self.i += 1;
        Ok(())
    }

    fn number(&mut self) -> Result<f64, ParseError> {
        let start = self.i;
        if self.peek() == b'-' {
            self.i += 1;
        }
        while self.peek().is_ascii_digit() || self.peek() == b'.' {
            self.i += 1;
        }
        core::str::from_utf8(&self.s[start..self.i])
            .ok()
            .and_then(|t| t.parse::<f64>().ok())
            .filter(|v| v.is_finite())
            .ok_or(ParseError { at: start, kind: ErrorKind::BadNumber })
    }

    fn positive(&mut self) -> Result<f64, ParseError> {
        let at = self.i;
        let v = self.number()?;
        if v <= 0.0 || v > 64.0 {
            return Err(ParseError { at, kind: ErrorKind::BadNumber });
        }
        Ok(v)
    }

    fn int(&mut self, min: usize, max: usize) -> Result<usize, ParseError> {
        let at = self.i;
        let v = self.number()?;
        if v.fract() != 0.0 || v < min as f64 || v > max as f64 {
            return Err(ParseError { at, kind: ErrorKind::BadNumber });
        }
        Ok(v as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(src: &str, cycle: i64) -> Vec<Event> {
        let p = Pattern::parse(src).unwrap();
        let mut buf = [Event::EMPTY; MAX_EVENTS];
        let n = p.query(cycle, &mut buf);
        buf[..n].to_vec()
    }

    fn onsets(src: &str, cycle: i64) -> Vec<f64> {
        events(src, cycle).iter().map(|e| ((e.onset - cycle as f64) * 1000.0).round() / 1000.0).collect()
    }

    #[test]
    fn sequence_and_rests() {
        assert_eq!(onsets("x . x x", 0), [0.0, 0.5, 0.75]);
        assert_eq!(onsets("x ~ x x", 5), [0.0, 0.5, 0.75]);
    }

    #[test]
    fn subdivision() {
        assert_eq!(onsets("x [x x]", 0), [0.0, 0.5, 0.75]);
        assert_eq!(onsets("[x [x x]] x", 0), [0.0, 0.25, 0.375, 0.5]);
    }

    #[test]
    fn alternation_per_cycle() {
        assert_eq!(onsets("x <x [x x]>", 0), [0.0, 0.5]);
        assert_eq!(onsets("x <x [x x]>", 1), [0.0, 0.5, 0.75]);
        assert_eq!(onsets("x <x [x x]>", 2), [0.0, 0.5]);
        // Nested alternation: a, b, a, c.
        let vals: Vec<f32> = (0..4).map(|c| events("<0 <1 2>>", c)[0].value).collect();
        assert_eq!(vals, [0.0, 1.0, 0.0, 2.0]);
    }

    #[test]
    fn fast_slow_and_alternation_under_fast() {
        assert_eq!(onsets("x*4", 0), [0.0, 0.25, 0.5, 0.75]);
        assert_eq!(onsets("x/2", 0), [0.0]);
        assert!(onsets("x/2", 1).is_empty());
        assert_eq!(onsets("[x x]/2", 1), [0.0]);
        let vals: Vec<f32> = events("<0 1>*2", 0).iter().map(|e| e.value).collect();
        assert_eq!(vals, [0.0, 1.0]);
    }

    #[test]
    fn euclid_and_rotation() {
        assert_eq!(onsets("x(3,8)", 0), [0.0, 0.375, 0.75]);
        assert_eq!(onsets("x(3,8,2)", 0), [0.125, 0.5, 0.75]);
    }

    #[test]
    fn polymeter_steps_through_children() {
        let vals = |c| events("{0 1 2}%4", c).iter().map(|e| e.value).collect::<Vec<_>>();
        assert_eq!(vals(0), [0.0, 1.0, 2.0, 0.0]);
        assert_eq!(vals(1), [1.0, 2.0, 0.0, 1.0]);
    }

    #[test]
    fn replicate_velocity_chance_and_values() {
        assert_eq!(onsets("x!3", 0).len(), 3);
        let e = events("x:0.25 X 3? -2?0.1", 0);
        assert_eq!((e[0].vel, e[1].vel), (0.25, 1.0));
        assert!(e[0].value.is_nan());
        assert_eq!((e[2].value, e[2].chance), (3.0, 0.5));
        assert_eq!((e[3].value, e[3].chance), (-2.0, 0.1));
    }

    #[test]
    fn negative_cycles_work() {
        assert_eq!(onsets("x <x [x x]>", -1), [0.0, 0.5, 0.75]);
    }

    #[test]
    fn parse_errors() {
        let kind = |s| Pattern::parse(s).unwrap_err().kind;
        assert_eq!(kind("[x x"), ErrorKind::Unclosed);
        assert_eq!(kind("x ]"), ErrorKind::Unexpected);
        assert_eq!(kind("x*0"), ErrorKind::BadNumber);
        assert_eq!(kind("q"), ErrorKind::Unexpected);
        assert_eq!(kind("   "), ErrorKind::Empty);
        assert_eq!(kind("<>"), ErrorKind::Empty);
        assert_eq!(Pattern::parse("x x q").unwrap_err().at, 4);
        assert_eq!(kind(&"[".repeat(40)), ErrorKind::TooBig);
    }

    #[test]
    fn caps_events() {
        assert_eq!(events("x*64 x*64", 0).len(), MAX_EVENTS);
    }
}
