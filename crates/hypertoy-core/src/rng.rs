//! Deterministic, stateless randomness. Toys key every roll by
//! (world seed, toy, step) so any client can recompute it without syncing events.

#[inline]
pub fn splitmix(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

#[inline]
pub fn hash3(a: u64, b: u64, c: u64) -> u64 {
    splitmix(a ^ splitmix(b ^ splitmix(c)))
}

/// Map a hash to [0, 1).
#[inline]
pub fn unit(h: u64) -> f32 {
    (h >> 40) as f32 / (1u64 << 24) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_key_same_roll() {
        assert_eq!(hash3(1, 2, 3), hash3(1, 2, 3));
        assert_ne!(hash3(1, 2, 3), hash3(1, 2, 4));
    }

    #[test]
    fn unit_is_in_range() {
        for i in 0..1000 {
            let u = unit(hash3(7, i, 0));
            assert!((0.0..1.0).contains(&u));
        }
    }
}
