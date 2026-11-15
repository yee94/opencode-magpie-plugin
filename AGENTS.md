# Working agreements

Keep both packages self-contained: runtime code and pricing live in their owning package under `packages/`; runtime dependencies remain empty. The workspace root is private tooling only.

Release: before changing versions, editing release automation, pushing tags, or recovering a failed publish, read [docs/releasing.md](docs/releasing.md). That document owns the release procedure and completion criteria.

Pricing: preserve model aliases, provider overrides and unknown-price behavior when editing `packages/opencode-magpie-plugin/src/model-pricing.ts`; account for changed rates in the pricing tests and release notes.
