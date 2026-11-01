StellaSnipes — Changelog
2026-07-16 — Funnel Recall Fix
Symptom
A large domain ingestion run produced an unexpectedly small lead-generation pool on Windows live runs.

Root cause: OneDrive null-byte corruption in scorer.js caused the scorer to return has_geo=false for affected records. pipeline.js also contained a duplicate has_geo override that masked scorer values, while gatekeeper.js was rejecting too many candidates.

Fix 0 — Null-byte strip
Removed the corrupt bytes from scorer.js using a binary read/write operation.

This restored correct scoring behavior and recovered the live candidate pool.
Fix 1 — Geo anchor removed (scorer.js, pipeline.js)
Before: Micro-geographic matches only counted when the city appeared at the beginning or end of the domain core. Valid city and service combinations embedded elsewhere in the name were missed.

After: City matches are recognized anywhere in the domain core. A minimum match-length check remains to reduce false positives. hasMicroGeo was updated to use the same matching behavior.

[REDACTED: Exact matching threshold and production pool measurements.]
Fix 2 — has_geo ownership (pipeline.js)
Before: pipeline.js independently recomputed geographic eligibility, overriding the value produced by scorer.js. This duplicated logic across two modules.

After: Removed the duplicate override. scorer.js is now the single source of truth for has_geo.

The corruption and matching fixes restored the scorer's reliability.

[REDACTED: Local environment and version-control filesystem issue.]
Fix 3 — Gatekeeper loosened (gatekeeper.js)
Three changes were applied together. The original file was truncated during editing and required a full rewrite.

3a — Removed repeated-substring rejection.

The previous check rejected some legitimate geographic and service names because they contained repeated character sequences.

3b — Removed corporate and B2B terms from _isContentSite.

Removed terms such as enterprise, solutions, corporation, consulting, holdings, associates, partners, and international.

These terms are better handled as scoring penalties than as unconditional gate exclusions. Valid commercial candidates should reach the scoring stage.

3c — Removed the hard domain-core length rejection.

Longer commercial names were being rejected before scoring. Length is now handled by the scorer's ranking logic rather than an unconditional gate.

[REDACTED: Exact length threshold, scoring penalty multiplier, and production gate/pool measurements.]
Final state
- Recovered geographic matching behavior.
- Centralized geographic eligibility ownership in scorer.js.
- Reduced false-positive gate exclusions.
- Preserved scoring penalties as ranking decisions rather than hard eligibility rules.
- Restored a substantially larger candidate pool for downstream lead selection.
[REDACTED: Exact production counts, pass rates, and served-candidate limits.]
Candidate examples
[REDACTED: Production domain candidates and ranked survivor list.]
