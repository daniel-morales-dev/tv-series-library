# Changelog

Los cambios notables de Sala. Se genera desde los Conventional Commits.
Las versiones anteriores a 0.6.1 viven en las releases de GitHub.

## 0.6.1

### Bug Fixes
- **ci:** correct the setup-node commit SHA in the release workflow (`261eac1`)
- **packaging:** speak the system language in the macOS installer (`5da3bcc`)
- **ingest:** Frieren pending episodes placed and cleared (#14) (`b35cf71`)

### Documentation
- **packaging:** drop a stale pointer in the installer comment (`f01f912`)
- **packaging:** make the macOS DMG quick guide trilingual (`cb088c8`)
- **packaging:** add English and Portuguese installer guides (`642564e`)
- **readme:** add English and Portuguese translations (`b19db84`)
- **readme:** add screenshots section and fix title and status (`c43b7be`)
- **readme:** add step-by-step install guides for Windows, macOS and Linux (`dba32f1`)
- **tasks:** round 5 closed - PR #13 merged, v0.6.0 with Windows and macOS installers (`73f2876`)

### CI
- **release:** publish a release with changelog when main warrants it (`9c530dd`)
- **macos:** check the installer language branch on a real macOS runner (`fa890e2`)
- **security:** scan git history for secrets with gitleaks (`776cd51`)

### Maintenance
- **license:** add MIT license (`a948994`)

**Full diff**: https://github.com/daniel-morales-dev/tv-series-library/compare/v0.6.0...v0.6.1
