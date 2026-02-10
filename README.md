> **⚠️ OFFICIAL SOURCE CODE – TRANSPARENCY & AUDIT ONLY**  
> **Redistribution · Republishing · Rebranding strictly prohibited**  
> This repository contains the exact code shipped to all users of OverPhish.  
> It is published only for independent verification and security auditing.

# OverPhish – Real-time Phishing & Malware Domain Blocker

**Source code published for transparency and independent auditing**

<img src="https://overphish.app/logo.png" width="128" align="right" alt="OverPhish icon">

![1M+ domains blocked](https://img.shields.io/badge/Blocks-1M%2B%20phishing%20%2B%20malware%20domains-critical?style=flat-square)
![Zero telemetry](https://img.shields.io/badge/Privacy-100%25%20local,%20zero%20telemetry-success?style=flat-square)
![Daily updated](https://img.shields.io/badge/Blocklist-Daily%20merged-blue?style=flat-square)

This repository contains the **exact, unmodified source code** of the OverPhish extension currently published on:

- [Chrome Web Store](https://chromewebstore.google.com/detail/overphish-phishing-domain/mapbfceckmkfnmecoadhfehmdpoomjoa)
- Microsoft Edge Add-ons
- Firefox Add-ons (AMO)

### Purpose of this public repository

- Full transparency for users and security researchers
- Independent third-party code audits
- Verification that the published extension matches this source
- Responsible vulnerability disclosure

### What you are allowed to do

- Read and analyze the code
- Fork this repository
- Build and load it as an **unpacked/temporary extension** for personal, non-commercial use
- Open issues or submit pull requests (especially security fixes)
- Report vulnerabilities → [OverPhish.com](https://overphish.app/#contact-heading)

### What you are explicitly NOT allowed to do

- Redistribute this extension in any form (source or compiled)
- Publish it (or any derivative) to the Chrome Web Store, Edge Add-ons, Firefox Add-ons, Opera Add-ons, or any other extension store
- Use the name **OverPhish**, the logo, icons, branding, or any confusingly similar marks
- Create and distribute modified versions under any name without explicit written permission

**Violations will be enforced via DMCA takedowns and, if necessary, legal action.**

### Official downloads only

| Browser             | Official Store Link                                                     | Verified |
| ------------------- | ----------------------------------------------------------------------- | -------- |
| Chrome              | [Chrome Web Store](https://chromewebstore.google.com/detail/overphish/) | Yes      |
| Edge                | (Launching soon)                                                        | Pending  |
| Firefox             | (Launching soon)                                                        | Pending  |
| Brave/Opera/Vivaldi | Use the Chrome Web Store link above                                     | Pending  |

**Never install OverPhish from anywhere else.**

### Technical highlights

- Blocks >1,000,000 phishing + malware domains daily
- Merged from OpenPhish • PhishTank • URLHaus • Hagezi TIF • Jarelllama Scam Blocklist
- 100% local processing — no data ever leaves your browser
- Fast probabilistic + exact matching via Bloom filter + reversed suffix trie
- Manifest V3 compliant with dynamic blocking + fallback redirect
- No permissions beyond what is strictly required

### Privacy

OverPhish collects **absolutely nothing**.

The only network request is the daily blocklist download from:  
**https://overphish.io/blocklist.txt** (public, plain-text, no tracking)

Everything else runs entirely in your browser.

[Privacy Policy →](./extension/privacy/privacy.html)

### Contact & security reports

[Contact Us](https://overphish.app/#contact-heading)
All responsible disclosures are welcomed and rewarded with credit (or bounty if significant).

### Copyright & License

**Copyright © 2025 OverPhish.app – All rights reserved.**

This source code is released **solely for transparency and auditing**.  
It is **not** an open-source license.

See the full legal notice in [LICENSE](./LICENSE)

---

**Thank you for helping keep the web safer.**
