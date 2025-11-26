/* OverPhish – https://overphish.app
 * This file is part of the official OverPhish extension.
 * Redistribution and publication to extension stores is strictly prohibited.
 * © 2025 OverPhish.app – All rights reserved.
 */

// Tiny, fast, zero-dependency Bloom Filter for browser/service worker
// Based on: https://en.wikipedia.org/wiki/Bloom_filter

class BloomFilter {
    constructor(size = 1000000, hashCount = 7) {
        this.size = size;
        this.hashCount = hashCount;
        this.bitArray = new Uint8Array(size);
    }

    // MurmurHash3 (non-crypto, fast)
    _hash(seed, str) {
        let h = seed ^ str.length;
        for (let i = 0; i < str.length; i++) {
            let c = str.charCodeAt(i);
            h = Math.imul(h ^ c, 3432918353);
            h = h << 13 | h >>> 19;
        }
        h = Math.imul(h ^ (h >>> 16), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        return (h ^= h >>> 16) >>> 0;
    }

    add(str) {
        for (let i = 0; i < this.hashCount; i++) {
            const hash = this._hash(i * 0xf1234567, str);
            const index = hash % this.size;
            this.bitArray[index] = 1;
        }
    }

    mightContain(str) {
        for (let i = 0; i < this.hashCount; i++) {
            const hash = this._hash(i * 0xf1234567, str);
            const index = hash % this.size;
            if (!this.bitArray[index]) return false;
        }
        return true;
    }

    // For debugging
    getLoadFactor() {
        return Array.from(this.bitArray).filter(b => b === 1).length / this.size;
    }
}

// Export for service worker
self.BloomFilter = BloomFilter;