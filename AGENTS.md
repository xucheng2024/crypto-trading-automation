# Python / Ruff Rules

- Do not run `ruff format .` automatically.
- Do not reformat unrelated existing files.
- Do not run repository-wide auto-fixes unless explicitly requested.
- By default, run `ruff check` only on Python files modified in the current task.
- Run `ruff check .` only when explicitly requested or before a commit/release.
- By default, run `ruff format --check` only on Python files modified in the current task when formatting validation is needed.
- Run `ruff format --check .` only when explicitly requested or before a commit/release.
- Only run `ruff format` on Python files modified in the current task.
- Only run `ruff check --fix` on Python files modified in the current task.
- Preserve existing formatting in untouched legacy files.
- Keep functional changes and formatting-only changes separate.

# Repository Scope

- Only inspect files relevant to the requested task.
- Do not scan the entire repository unless necessary.
- Do not modify unrelated files.
- Prefer targeted searches and targeted tests over repository-wide operations.
- Check `git status` before making changes and preserve unrelated existing modifications.

# Tool / Context Usage

- Use Context7 only when current third-party library or API documentation is needed.
- Do not use external tools when the answer can be determined from the repository.
- Keep command output and final responses concise.

# UI Validation

- Do not perform broad exploratory UI validation.
- Only validate pages and components changed in the current task.
- Use automated checks before visual inspection whenever possible.
- Default mobile viewport: 390x844.
- For normal UI tasks, validate only Chromium unless cross-browser testing is explicitly requested.
- Do not inspect unrelated routes or pages.
- Take at most one final screenshot per changed page unless debugging requires more.
- Avoid repeated screenshot-inspect-edit loops after every small change.
- Prefer one implementation pass followed by one validation pass.
- Use Playwright assertions for mechanical checks such as visibility, overflow, clickability, form submission, console errors, and failed network requests.
- Run full multi-browser validation only when explicitly requested or before release.
- Keep UI validation output concise and report only failures or important findings.

# Azure / Deployment

- Use GitHub Actions as the default production deployment path.
- Do not manually deploy to Azure unless explicitly requested.
- Do not repeatedly inspect Azure resources during normal code changes.
- For deployment failures, inspect only the failed GitHub Actions step and relevant Azure resource.
- Prefer existing deployment scripts/workflows over ad-hoc Azure CLI commands.
- Do not change production revisions, traffic, secrets, or infrastructure unless required by the task.

# Azure Investigation

- Start with the narrowest known failure signal, usually the failed GitHub Actions step or affected Azure service.
- Do not perform broad Azure resource discovery unless necessary.
- Do not repeatedly list subscriptions, resource groups, or unrelated resources.
- Prefer targeted `az` queries with explicit resource names.
- Limit log queries to recent time windows and small output sizes.
- For Container Apps, inspect only the affected app, active revision, health, traffic, and recent errors.
- Stop investigating unrelated services once a likely root cause is identified.
- Do not dump full configurations, environment variables, or large logs into context.

# Code Review

- Start from the current diff.
- Review directly affected code and follow relevant dependency paths when needed.
- Check callers, consumers, shared interfaces, schemas, configuration, and tests that may be affected by the change.
- Expand beyond the diff only when there is a concrete dependency or regression path to investigate.
- Do not perform a broad repository-wide review without evidence that it is necessary.
- Prioritize correctness, regressions, security, data loss, compatibility, and operational risk.
- Ignore style-only issues already covered by automated tooling.
- Report only actionable findings, ordered by severity.

# Post-Change Review

- After implementation, perform one focused review of the current diff and realistic impact paths.
- Do not start an open-ended review/fix loop.
- If the review finds clear, actionable issues caused by the current change, fix them in one targeted pass.
- After that fix pass, run one final targeted validation.
- Do not perform another full review unless the final validation fails or the user explicitly requests it.
- Ignore speculative, style-only, or unrelated legacy issues during post-change review.
- Stop once the requested change is correct and sufficiently verified.
