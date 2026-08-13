# pi-process-monitor 2.0.2 completion audit

Reviewed: 2026-08-13

## Incident reproduced

Source session:

`~/.pi/agent/sessions/--Users-ffrappo-works-repos-trendwalker-sentia--/2026-08-11T20-12-22-229Z_019ff274-6555-7387-8692-05e6668becc2.jsonl`

`fornace-max` emitted the same malformed 2.0.1 call at least 18 times. Every
call contained a real `command`, empty `logFile`, and a fabricated nonempty
HTTP/process `probe`, plus every common optional field. The model's prose said
it would omit fields, but the strict tool decoder materialized them again.

## Root cause

OpenAI strict function calling requires every declared property to appear in
`required`; optional values must include `null` in their type. Version 2.0.1
instead exposed three mutually exclusive optional root fields and attempted to
preserve `required: []`. The Fornace OpenAI-compatible strict normalizer made
all root fields required, so a valid exactly-one-source payload could not be
serialized.

The 2.0.1 `prepareArguments` shim removed empty placeholders only when exactly
one source was populated. It correctly refused to guess when the provider
invented a plausible nonempty probe, but this left the call unusable.

Official source reviewed 2026-08-13:

- https://developers.openai.com/api/docs/guides/function-calling
  - Strict mode requires `additionalProperties: false` on each object.
  - Every property must be required.
  - Optional values are represented by including `null` as a type option.
- https://docs.npmjs.com/trusted-publishers/
  - Trusted publishing requires npm 11.5.1+ and Node 22.14.0+.

Installed versions reviewed:

- Pi CLI: 0.84.1
- Package dev Pi: 0.80.2
- TypeBox: 1.3.2
- Local npm: 11.16.0

## Fix

The provider-facing tool now has two required root fields:

- `source`: one object with required `type` discriminator;
- `options`: nullable object.

All source values are required-and-nullable for strict transport. `source.type`
is authoritative and selects one of `spawn`, `poll`, `tail`, `process`,
`file`, `ssh`, or `http`. Unrelated generated values are ignored and reported.
`processBy` selects `pidFile` or `match` to remove the remaining process-probe
ambiguity.

Legacy top-level `command`, `logFile`, and `probe` calls are normalized in
`prepareArguments` before schema validation. Stored state and runtime config
are unchanged.

Validation errors name the selected/conflicting fields and include a valid
minimal JSON example. Successful results instruct agents to use
`monitor_status` instead of repeating `monitor` for status.

## Feature-preservation matrix

| Capability | 2.0.2 source | Runtime mapping | Evidence |
|---|---|---|---|
| One-shot local workload | `spawn` | `command`, no cadence | boundary test + live Fornace/Gemini |
| Read-only command polling | `poll` | `command + intervalSeconds` | boundary test; unsafe workload still quarantines |
| Log tail | `tail` | `logFile` | boundary test + existing file runtime tests |
| Process probe | `process` | `probe.type=process` | `processBy` test |
| Structured file probe | `file` | `probe.type=file` | boundary test |
| SSH probe | `ssh` | `probe.type=ssh` | boundary test |
| HTTP probe | `http` | `probe.type=http` | boundary test |
| Slash commands | unchanged | direct `runtime.launch` | no diff in `commands.ts` |
| Recovery/state/leases | unchanged | existing `WatcherConfig` | no diff in runtime/state/identity/lease modules; 41 tests |
| Reuse/replace/parallel | options mapping | unchanged runtime | existing runtime tests |
| Inspect/kill/recover/GC | unchanged tools | unchanged runtime | extension load smoke |

No feature was removed. The other agent's statement that spawn must omit
`intervalSeconds` exposed an old implicit-mode ambiguity: in 2.0.1,
`command + intervalSeconds` intentionally selected local poll. In 2.0.2 this
capability remains available as explicit `source.type="poll"`; `spawn` always
means run once.

## Live provider receipts

### Fornace strict path

Command used an isolated Pi process with only the local extension and
`fornace/fornace-max`. The raw call contained every source property, with
irrelevant fields set to null:

```json
{
  "options": null,
  "source": {
    "type": "spawn",
    "command": "printf raw-shape-ok",
    "path": null,
    "processBy": null,
    "pidFile": null,
    "match": null,
    "host": null,
    "url": null,
    "method": null,
    "tailLines": null,
    "intervalSeconds": null
  }
}
```

Result: `isError=false`, runtime mode `spawn`, clean exit ping.

An uncoached natural-language call (`Use monitor to run printf
natural-schema-ok once`) emitted one `monitor` call and then used
`monitor_status` after the success message explicitly directed it there.

### Google path

An isolated Pi process using `google/gemini-3.1-pro-preview` emitted the same
strict-compatible nullable source shape. Result: `isError=false`, runtime mode
`spawn`, clean exit ping. This proves the nullable JSON Schema survives Pi's
current Gemini `parametersJsonSchema` transport.

## Release evidence

Completed before publication:

```bash
MONITOR_TEST_PROVIDER=fornace MONITOR_TEST_MODEL=fornace-max npm run validate
npm pack --dry-run --json
```

Results:

- Commit/tag artifact: `2ddf234`, `v2.0.2`.
- GitHub Actions OIDC run `31698950484`: success through Publish.
- npm `latest`: `2.0.2`.
- Registry integrity: `sha512-cTZhkqOP9q6w8e3F5PdJ0CrIeiqyhtl/Y4wR5N+GVR1DcuDsBaudg021g8uK5xvzNfNLt72cH7thivpnsEVm7A==`.
- Registry artifact live Pi call: exactly one `monitor` call, mode `spawn`, clean exit ping.
- SLSA provenance: published to Sigstore transparency log index `2450856931`.
- GitHub release: https://github.com/Fornace/pi-process-monitor/releases/tag/v2.0.2

The GitHub workflow uses Node 24, npm 11.5.1+, `id-token: write`, and no
long-lived publish token. The trusted publisher is configured for
`Fornace/pi-process-monitor`, workflow `publish.yml`, action `npm publish`.
