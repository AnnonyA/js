# jsconfuser-decompiler

A TypeScript foundation for reversing JavaScript transformed by js-confuser, with separate **safe** and **clean** outputs, diagnostics, provenance, transactional AST changes, and deterministic reporting.

## Requirements

- Node.js 22.12.0 or newer
- npm

## Build and test

```bash
npm install
npm test -- --run
npm run typecheck
npm run build
```

## CLI

```bash
node dist/cli/cli.js input.js
```

By default the CLI creates a `decompiled` directory beside the input containing:

- `<name>.safe.js`
- `<name>.clean.js`
- `<name>.report.json`

Useful flags include `--target`, `--dynamic`, `--config`, `--out`, `--safe-only`, `--clean-only`, `--no-dynamic`, `--trace`, `--report`, `--confidence`, and `--analyze-only`.

## Library API

```js
import { decompile } from "jsconfuser-decompiler";

const result = await decompile("export const answer = 42;");
console.log(result.safeCode);
console.log(result.cleanCode);
console.log(result.report);
```

For file-based use:

```js
import { decompileFile } from "jsconfuser-decompiler";

await decompileFile("input.js", {
  outputDirectory: "decompiled",
});
```

## Architecture

The engine parses input into independent input/safe/clean AST branches. Reverse passes are registered through a capability-aware scheduler and AST transformations are transactional: invalid candidates are rolled back and recorded in diagnostics/provenance instead of corrupting output.

The current foundation intentionally prefers conservative analysis and explicit `unknown` states over unsafe guessing. Reverse transforms for concrete js-confuser families are layered on top of this core.
