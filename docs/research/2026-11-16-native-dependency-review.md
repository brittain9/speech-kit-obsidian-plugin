# Native patch dependency review

Dependabot PR #537 updates uuid 1.29.0 to 1.29.1 and llama-cpp-sys-2 0.1.160 to
0.1.161. The
[uuid release](https://github.com/uuid-rs/uuid/releases/tag/v1.29.1) fixes v7
monotonicity and lint/deprecation issues; Speech Kit uses v4 IDs and serde.
No session ID policy changes are needed.

The [llama-cpp-rs release diff](https://github.com/utilityai/llama-cpp-rs/compare/0.1.160...0.1.161)
does not change the vendored llama.cpp commit or native build script. Both tags
point to llama.cpp `d81235049384534c167caea52b85a694f6103d14` and the same
`build.rs`. The new wrapper release adds a tensor-split setter that Speech Kit
does not use.

Keep the existing exact llama-cpp-2 0.1.160 wrapper pin. Its
[manifest](https://github.com/utilityai/llama-cpp-rs/blob/0.1.160/llama-cpp-2/Cargo.toml)
accepts sys 0.1.161 under its declared compatible dependency range.
`cargo tree --locked --features engine-hy-mt -i llama-cpp-sys-2` confirms that the
application and wrapper resolve to one sys 0.1.161 instance. There is no duplicate
native runtime. Unchanged vendored source supports this compatibility choice;
the normal native CI/helper checks remain the validation gate.

License terms remain MIT/Apache-2.0 for the binding and MIT for llama.cpp; existing
third-party notices still describe the shipped helper. The exact-version OSV
queries returned no known advisory for uuid 1.29.1, llama-cpp-2 0.1.160, or
llama-cpp-sys-2 0.1.161 on 2026-11-16. That covers published advisory records for
these versions rather than a complete security audit. No model artifact or
inference behavior changes are introduced by this PR's source diff.
