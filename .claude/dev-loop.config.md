---
name: Dev loop project config
description: zzapi-mes dev-loop configuration
type: config
---

# Dev Loop — zzapi-mes

> SAP ICF REST handler SDK + CLI for MES integration on SAP_BASIS 700.

## Identity

```yaml
slug: zzapi-mes
vault: ~/wiki
release_branch: main
```

## Code layout

```yaml
cli_src: packages/cli/src/
cli_test: packages/cli/src/cli.test.ts
skills_glob:
cli_entry_override:
```

## E2E

No automated e2e suite. Smoke tests require SAP credentials and deployed handlers.

```yaml
e2e_scripts: []
```

## Release

ABAP handlers are deployed manually via SE24/SICF. Hub deploys via tar+scp to msi-1.

```yaml
bump_script:
publish_via: none
manifests_count: 5
remote_hosts: [msi-1]
```

## Notes

```yaml
notes:
  abap_deploy: Manual via SE24/SICF on SAP (msi-1 Parsec/RDP → SAP GUI)
  hub_deploy: bash apps/hub/deploy/update-msi1.sh
  known_test_failures: 3 CLI tests fail on main (--mode flag, hub mode, confirm command)
  smoke: pnpm smoke against sapdev.fastcell.hk:8000
```
