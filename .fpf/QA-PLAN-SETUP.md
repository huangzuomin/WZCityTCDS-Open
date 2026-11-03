# Independent QA plan

A real separate reviewer must configure .fpf/qa-plan.json on protected main with one physical command argv array for every mandatory EVID-XX except the collector-produced EVID-31/EVID-32. Without this explicitly reviewed plan, workflow_dispatch fails. See FPF docs/AUDIT-ROUND5.md.
