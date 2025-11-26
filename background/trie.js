/* OverPhish – https://overphish.app
 * This file is part of the official OverPhish extension.
 * Redistribution and publication to extension stores is strictly prohibited.
 * © 2025 OverPhish.app – All rights reserved.
 */

class TrieNode {
    constructor() {
        this.children = {};
        this.isEnd = false;
    }
}

class DomainTrie {
    constructor() {
        this.root = new TrieNode();
    }

    insert(reversedDomain) {
        let node = this.root;
        for (const char of reversedDomain) {
            node = node.children[char] = node.children[char] || new TrieNode();
        }
        node.isEnd = true;
    }

    // Check if any suffix matches
    searchSuffix(reversedHostname) {
        let node = this.root;
        for (const char of reversedHostname) {
            if (!node.children[char]) return false;
            node = node.children[char];
            if (node.isEnd) return true;
        }
        return node.isEnd;
    }
}

self.DomainTrie = DomainTrie;