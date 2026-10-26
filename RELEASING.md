# Releasing

The repository is private at the npm workspace root, not on GitHub. Publish the
public leaf packages only. DSH remains private until its release is ready.

| Directory | Package | Initial monorepo release |
|---|---|---|
| `packages/core` | `@seangle/remember-core` | 0.1.0 |
| `packages/migrators` | `@seangle/remember-migrators` | 0.1.0 |
| `packages/pi` | `@seangle/pi-remember` | 0.3.0 |

## Prepare and verify

1. Update package versions, internal dependency ranges, and the Pi changelog.
2. Run `pnpm install --offline` to refresh workspace links and the lockfile.
   Registry-compatible dependency ranges resolve locally via
   `linkWorkspacePackages: true`; published manifests contain no `file:` links.
3. Run `npm run check` and `npm run test:packed`.
4. Inspect `git diff`, commit, and push the release source to GitHub before
   publishing immutable npm artifacts.

`npm run pack` builds JavaScript and copies the root license into each package,
then creates and validates tarballs under the gitignored `artifacts/` directory.
Each public package also has a `prepack` hook so direct packing builds first.
`test:packed` installs the three tarballs offline in a fresh directory outside
the workspace, suppresses automatic host-peer installation, and exercises all
ten tools, migrations, recovery, commands, and prompt injection. It retains that
temporary installation for inspection.

## Publish

After obtaining permission for remote operations, publish the **tested
tarballs**, not repacked directories, in dependency order:

```sh
npm publish ./artifacts/seangle-remember-core-0.1.0.tgz --access public
npm publish ./artifacts/seangle-remember-migrators-0.1.0.tgz --access public
npm publish ./artifacts/seangle-pi-remember-0.3.0.tgz --access public
```

Wait for each dependency to resolve from the public registry before publishing
the next package. Verify versions, dependency ranges, tarball integrity, and the
`latest` tags with `npm view`. Test a fresh registry-based install without
workspace links, then create package-specific git tags matching the released
versions. Do not overwrite or unpublish a version to fix a packaging error:
publish a corrected version instead.

The legacy `Esensats/pi-remember` repository is historical. Updating or archiving
it is a separate, explicitly authorized action. Do not deprecate the npm name:
`@seangle/pi-remember` is still the active Pi adapter.
