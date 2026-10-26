# @seangle/remember-migrators

Explicit legacy-store migration for
[agents-remember](https://github.com/Esensats/agents-remember), separate from its
host-agnostic core.

## Install

```sh
npm install @seangle/remember-migrators
```

Requires Node.js >=22.15. Published code is plain ESM JavaScript.

## API

```js
import { migrate } from "@seangle/remember-migrators";

const options = {
  source: "/absolute/workspace/.pi/memory",
  target: "/absolute/workspace/.agents/memory",
};

// Inspect the plan and skipped content before obtaining consent to apply.
const preview = await migrate({ ...options, dryRun: true });
console.log(preview);

// Only after user approval:
const result = await migrate(options);
console.log(result);
```

The `pi-remember-v1` strategy recognizes the legacy `pi-remember.json`
version-1 marker. It copies current facts and valid frontmatter notes,
preserving memo IDs and paths. Invalid notes and duplicate IDs are skipped
and reported. Review the report: migration is best-effort, not a guarantee
that every source file was copied.

Recovery records, old migration backups, and other history are not copied.
The source is left in place. An existing target is refused rather than merged.
A recognized in-place legacy store (`source === target`) is validated and
receives only the new `remember.json` marker; existing files are not rewritten.

Older formats must first be upgraded with the legacy Pi extension. Stop all
writers while migrating, back up important stores, and do not mix legacy and
new writers on one store. See the
[migration documentation](https://github.com/Esensats/agents-remember#migration).

## License

Apache-2.0. Copyright 2026 Esensats.
