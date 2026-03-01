# Releasing

## After merge to `main`

1. Sync local main:

```bash
git checkout main
git pull --ff-only
```

2. Create and push tag:

```bash
git tag -a v1.0.0-core -m "v1 core cleanup"
git push origin v1.0.0-core
```

3. Create GitHub release from tag `v1.0.0-core` and include:
- Scope reduction to core workflow
- Defaults: cinematic + visible cursor
- Removed non-core experimental tooling
