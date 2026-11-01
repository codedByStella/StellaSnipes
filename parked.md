# PARKED — deliberately deferred, not forgotten

Known gaps in this codebase, each investigated and deliberately left as-is for now rather than silently broken or forgotten. This file exists so those decisions stay visible instead of getting rediscovered from scratch (or "fixed" halfway) months from now.

Delete an entry from this file only when it's actually been built, not when it's merely reconsidered.

---

## 1. Safe Browsing under-detects (URL canonicalization)

**Where:** `lib/health.js`, `checkSafeBrowsing()`.

**The gap:** The check currently evaluates a limited URL representation. Google Safe Browsing expects canonicalized URL expressions, so threats associated with alternate protocols, host forms, or paths can be missed.

**Why it's parked, not fixed:** The current behavior degrades toward missed detections rather than false hard-fails. The check also depends on external API access, so expanding coverage requires additional implementation and validation.

**What "done" looks like:** Generate the canonical URL-expression set according to the applicable Safe Browsing specification and evaluate the resulting expressions rather than only the bare host.

---

## 2. GoDaddy is one of several aftermarket sources — no multi-source integration

**Where:** `lib/godaddy.js`, `enrichDomains()`; marketplace data persistence in `lib/store.js`.

**The gap:** GoDaddy is only one of several competing aftermarket services. A domain not appearing in one marketplace does not mean it is absent elsewhere. Coverage remains partial when only one provider is queried.

Drop-catching and reservation-program timing also mean a domain identified during an early lifecycle stage may not yet appear in any marketplace.

**Why it's parked, not fixed:** Each additional source requires separate authentication, rate-limit handling, response normalization, and integration work. This is a meaningful feature rather than a quick addition.

The persistence layer already uses generic marketplace fields, allowing additional providers to be integrated without redesigning the existing data model.

**What "done" looks like:** Add another aftermarket provider with an enrichment function following the existing integration pattern. Persist its results through the shared marketplace fields while identifying the source.

---

## 3. Toxic-content blacklist has incomplete matching coverage (HIGH PRIORITY)

**Where:** `lib/registry.js`, `RegistryLoader._compile()`; `lib/gatekeeper.js`, `purge()`; `lib/health.js`, `screenContent()`.

**The gap:** A minimum match-length filter intended to reduce false positives is applied uniformly across registries. This creates a problem for registries containing short, common terms that still need to be detected.

The same registry is also consumed by two separate screening paths with different matching behavior. As a result, the ingestion gate and later content screening can disagree about whether a term should match.

**Why it's parked, not fixed:** The correct solution needs to be selected before implementation. Options include per-registry matching rules, whole-word boundary matching, or a shared compiled matching implementation.

**What "done" looks like:** Short entries in the toxic-content registry are detected reliably without introducing widespread substring false positives. Both screening paths should use consistent matching behavior or have an explicit reason for differing.

---

## 4. `checkBlacklists()` rewards the wrong kind of uncertainty (HIGH PRIORITY)

**Where:** `lib/health.js`, `checkBlacklists()`.

**The gap:** A known block or rate-limit response is correctly treated as unverified. However, a thrown DNS lookup exception can currently be interpreted as a clean result and receive the clean-result bonus.

A failed query provides less information than a successful query returning no listing. Treating both as equivalent rewards the least certain outcome.

**Why it's parked, not fixed:** Identified during a full repository audit. The correction has not yet been implemented.

**What "done" looks like:** DNS lookup exceptions are treated as unverified, just like known inconclusive responses. They must never receive a clean-result bonus.

---

## 5. Scheduler daemon does not coordinate with the run-lock mutex (HIGH PRIORITY)

**Where:** `lib/scheduler.js`, `SchedulerDaemon._tick()`; `lib/runlock.js`.

**The gap:** The scheduler can invoke the main pipeline independently of the existing run-lock coordination.

Other pipeline entry points already use shared state to prevent overlapping operations from competing for common resources. The scheduler is an additional entry point that does not currently participate in that coordination.

If a scheduled run fires while another run or startup refresh is active, both operations can execute concurrently and contend for shared rate limiters.

**Why it's parked, not fixed:** Identified during the repository audit. The scheduler integration has not yet been completed.

**What "done" looks like:** The scheduler respects existing run-lock state, yields when another pipeline operation is active, and exposes its own running state so other entry points can coordinate with it.

---

## 6. Gatekeeper's digit, hyphen, and content-word gates reject legitimate inventory

**Where:** `lib/gatekeeper.js`, `purge()`, `_likelyTypo()`, and `_isContentSite()`.

**The gap:** Several hard-rejection rules can exclude legitimate business domains alongside the undesirable patterns they were designed to catch.

This includes names containing digits, repeated characters, or terms that can appear in both content-oriented and legitimate commercial names.

Live testing confirmed that some plausible geographic and service combinations are rejected before reaching the scoring stage.

**Why it's parked, not fixed:** This is partly a judgment call about intended filtering severity, not an obvious defect. Some of the existing rules have legitimate spam-prevention rationale. The actual trade-off between false positives and unwanted inventory needs to be considered before changing them.

**What "done" looks like:** Either confirm the current gates are intentionally aggressive, or narrow the rules to distinguish legitimate naming patterns from the patterns they were designed to reject.

---

## 7. `assessNameQuality()` digit and hyphen penalties are dead code on the automated path

**Where:** `lib/scorer.js`, `assessNameQuality()`; `lib/gatekeeper.js`.

**The gap:** The gatekeeper already rejects certain name patterns before the primary automated scoring path reaches `scoreDomain()`. Consequently, some corresponding scoring penalties cannot execute on that path.

They remain reachable through a separate manual-add and re-audit path, which bypasses the gatekeeper.

This means similar rules are enforced differently depending on how a domain enters the system.

**Why it's parked, not fixed:** Low priority and informational. Identified during the repository audit.

**What "done" looks like:** Either remove the mostly unreachable penalty branches or explicitly document that they remain for the manual-add path.

---

## 8. `assessNameQuality()`'s reward block is all-or-nothing

**Where:** `lib/scorer.js`, `assessNameQuality()`.

**The gap:** Name-quality rewards are currently applied only when the accumulated penalty score is zero.

A name that receives one penalty therefore loses access to all otherwise applicable quality rewards, even if it has several positive characteristics.

This can create a larger score swing than the individual penalty suggests.

**Why it's parked, not fixed:** Low priority and informational. The current behavior is understood, but the scoring model has not yet been recalibrated.

**What "done" looks like:** Evaluate rewards and penalties independently so positive and negative characteristics can contribute to the final score without one automatically suppressing the other.

---

## 9. `audit_evidence` rows are never pruned

**Where:** `lib/store.js`, `pruneOldRuns()` and the `audit_evidence` table.

**The gap:** Historical run records are subject to retention cleanup, but stored audit evidence does not currently have a corresponding cleanup path.

Evidence belonging to domains whose run history has expired can therefore remain in the database indefinitely.

**Why it's parked, not fixed:** The immediate impact is small, but storage can grow over time. Identified during the repository audit.

**What "done" looks like:** Extend the existing cleanup process, or add a sibling cleanup method, to remove evidence for domains that no longer have retained run history.

---

## 10. Stale documentation comments in `czds.js`

**Where:** `lib/czds.js`, top-of-file documentation.

**The gap:** The module's introductory comments no longer accurately describe its current cache organization and retention behavior.

The implementation has changed, but the documentation was not updated alongside it.

**Why it's parked, not fixed:** Trivial documentation maintenance. Best handled during the next substantive change to the module.

**What "done" looks like:** Update the introductory comments to reflect the actual cache location and retention behavior.

---

## 11. Dead dependency: `dotenv`

**Where:** `package.json`.

**The gap:** `dotenv` is listed as a dependency but is not imported by the application. The configuration module currently handles environment-file parsing independently.

**Why it's parked, not fixed:** Trivial cleanup identified during the repository audit.

**What "done" looks like:** Remove the unused dependency and update the lockfile.

---

## Note, not a defect: valuator's ambiguous-city fallback leans optimistic

**Where:** `lib/valuator.js`, `_bestCity()`.

When a domain's city name is ambiguous and no state is specified, the fallback selects the highest-population matching city.

This introduces an optimistic bias into the valuation estimate. The uncertainty is explicitly disclosed in the output rather than hidden, but the direction of the bias is worth understanding.

No action is currently required unless this becomes a meaningful problem in practice.

---

*Items 1–2 originated from an earlier audit follow-up. Items 3–11 were identified during a subsequent full repository audit covering incorrect assumptions, implementation defects, dead code, and behavior that could harm business outcomes.*

*The highest-priority outstanding items concern toxic-content matching, blacklist uncertainty handling, and scheduler/run-lock coordination. These were confirmed during investigation and remain deferred rather than silently treated as resolved.*
