# Releasing

## Pre-release checklist

1. Check existing tags to find the next free version:
   ```bash
   git tag -l 'v*' --sort=-v:refname
   ```
2. Bump the version in all three places:
   - `package.json` → `"version"`
   - `src/cli.ts` → `.version()`
   - `CHANGELOG.md` → move items from `[Unreleased]` into a new `[x.y.z] - YYYY-MM-DD` section
3. Update `README.md` if the pinned version reference (`npx github:onprem-ai/mcp-key-proxy#vX.Y.Z`) needs updating.
4. Run tests and typecheck:
   ```bash
   npm run typecheck && npm test
   ```
5. Commit:
   ```bash
   git add package.json src/cli.ts CHANGELOG.md README.md
   git commit -m "chore: bump to vX.Y.Z"
   git push
   ```

## Publishing

Push a semver tag to trigger the publish workflow (`.github/workflows/publish.yml`):

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

This builds multi-platform Docker images (amd64 + arm64) and pushes them to:

- `ghcr.io/onprem-ai/mcp-key-proxy:X.Y.Z`
- `ghcr.io/onprem-ai/mcp-key-proxy:latest`

## Versioning

This project follows [Semantic Versioning](https://semver.org/):

- **Patch** (`0.4.1`) — bug fixes, no new flags or behavior changes
- **Minor** (`0.5.0`) — new features (e.g. new CLI flags), backward-compatible
- **Major** (`1.0.0`) — breaking changes to CLI flags, config, or HTTP API
