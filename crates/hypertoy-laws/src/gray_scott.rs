//! Gray-Scott reaction-diffusion: two reagents U and V on a wrapping grid.
//! U + 2V -> 3V, U is fed in, V is killed off. Turing patterns emerge.

const DU: f32 = 1.0;
const DV: f32 = 0.5;

/// (feed, kill) pairs along the reagent dial: spots, coral, mazes, worms.
const PRESETS: [(f32, f32); 4] = [(0.0367, 0.0649), (0.0545, 0.062), (0.029, 0.057), (0.078, 0.061)];

pub struct Field {
    pub w: usize,
    pub h: usize,
    u: Vec<f32>,
    v: Vec<f32>,
    u2: Vec<f32>,
    v2: Vec<f32>,
    prev_v: Vec<f32>,
    pub feed: f32,
    pub kill: f32,
    /// Mean concentration of V (how much "life" is in the kettle).
    pub coverage: f32,
    /// Mean |dV| over the last `step` call (how fast it is changing).
    pub activity: f32,
    /// V scaled to bytes, for rendering.
    pub view: Vec<u8>,
}

impl Field {
    pub fn new(w: usize, h: usize, seed: u64) -> Self {
        let n = w * h;
        let mut f = Field {
            w,
            h,
            u: vec![1.0; n],
            v: vec![0.0; n],
            u2: vec![1.0; n],
            v2: vec![0.0; n],
            prev_v: vec![0.0; n],
            feed: PRESETS[0].0,
            kill: PRESETS[0].1,
            coverage: 0.0,
            activity: 0.0,
            view: vec![0; n],
        };
        // A few seeded drops so the kettle starts alive.
        for i in 0..5u64 {
            let h1 = hypertoy_rng(seed, i, 1);
            let h2 = hypertoy_rng(seed, i, 2);
            f.drop(unit(h1), unit(h2), 0.05);
        }
        f
    }

    /// Morph the reagents along the preset path; `x` in [0, 1].
    pub fn set_reagent(&mut self, x: f32) {
        let t = x.clamp(0.0, 1.0) * (PRESETS.len() - 1) as f32;
        let i = (t.floor() as usize).min(PRESETS.len() - 2);
        let a = t - i as f32;
        self.feed = PRESETS[i].0 + (PRESETS[i + 1].0 - PRESETS[i].0) * a;
        self.kill = PRESETS[i].1 + (PRESETS[i + 1].1 - PRESETS[i].1) * a;
    }

    /// Pour reagent V in a disc at (x, y) in [0, 1], radius `r` as a fraction of width.
    pub fn drop(&mut self, x: f32, y: f32, r: f32) {
        let (w, h) = (self.w as i32, self.h as i32);
        let cx = (x * w as f32) as i32;
        let cy = (y * h as f32) as i32;
        let rr = (r * w as f32).max(1.0) as i32;
        for dy in -rr..=rr {
            for dx in -rr..=rr {
                if dx * dx + dy * dy > rr * rr {
                    continue;
                }
                let px = (cx + dx).rem_euclid(w) as usize;
                let py = (cy + dy).rem_euclid(h) as usize;
                let i = py * self.w + px;
                self.u[i] = 0.5;
                self.v[i] = 0.25;
            }
        }
    }

    pub fn step(&mut self, iterations: usize) {
        let (w, h) = (self.w, self.h);
        self.prev_v.copy_from_slice(&self.v);
        for _ in 0..iterations {
            for y in 0..h {
                let ym = if y == 0 { h - 1 } else { y - 1 } * w;
                let yp = if y == h - 1 { 0 } else { y + 1 } * w;
                let yc = y * w;
                for x in 0..w {
                    let xm = if x == 0 { w - 1 } else { x - 1 };
                    let xp = if x == w - 1 { 0 } else { x + 1 };
                    let i = yc + x;
                    let (u, v) = (self.u[i], self.v[i]);
                    let lap = |g: &[f32]| {
                        0.2 * (g[yc + xm] + g[yc + xp] + g[ym + x] + g[yp + x])
                            + 0.05 * (g[ym + xm] + g[ym + xp] + g[yp + xm] + g[yp + xp])
                            - g[i]
                    };
                    let uvv = u * v * v;
                    self.u2[i] = (u + DU * lap(&self.u) - uvv + self.feed * (1.0 - u)).clamp(0.0, 1.0);
                    self.v2[i] = (v + DV * lap(&self.v) + uvv - (self.kill + self.feed) * v).clamp(0.0, 1.0);
                }
            }
            core::mem::swap(&mut self.u, &mut self.u2);
            core::mem::swap(&mut self.v, &mut self.v2);
        }
        let n = (w * h) as f32;
        let mut sum = 0.0;
        let mut delta = 0.0;
        for i in 0..w * h {
            let v = self.v[i];
            sum += v;
            delta += (v - self.prev_v[i]).abs();
            self.view[i] = (v * 3.5 * 255.0).min(255.0) as u8;
        }
        self.coverage = sum / n;
        self.activity = delta / n / iterations.max(1) as f32;
    }
}

fn hypertoy_rng(a: u64, b: u64, c: u64) -> u64 {
    // Local splitmix so laws stay dependency-free.
    let mix = |mut x: u64| {
        x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        x ^ (x >> 31)
    };
    mix(a ^ mix(b ^ mix(c)))
}

fn unit(h: u64) -> f32 {
    (h >> 40) as f32 / (1u64 << 24) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_grow_from_seed_drops() {
        let mut f = Field::new(64, 64, 9);
        f.step(400);
        assert!(f.coverage > 0.01, "coverage {}", f.coverage);
        assert!(f.activity > 0.0);
    }

    #[test]
    fn deterministic() {
        let mut a = Field::new(32, 32, 3);
        let mut b = Field::new(32, 32, 3);
        a.step(50);
        b.step(50);
        assert_eq!(a.view, b.view);
    }
}
