# Public smoke tests

These tests cover the surfaces that a public clone can actually verify without the private corpus, frozen records, or a model provider:

- the `bin/bridlewise.mjs` launcher and its top-level help/version;
- the typed `harness` refusal and the honest `preflight` receipt;
- the secret/privacy scanner, including its failure modes;
- the required safety warning and documentation set;
- the licence and community files.

Run them with:

```bash
npm run test:public
```

They use Node's built-in test runner and have no third-party dependencies. The larger prevention, cockpit, and engine suites live in the separate `bridlewise-testing` repository and have additional prerequisites.
