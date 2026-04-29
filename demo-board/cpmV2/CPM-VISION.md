# Compliance for AI — V1 + V2 Vision & Demo Mapping

## The Thesis

**Compliance for AI is two coupled planes.**
*Drift is Default — AI systems require continuous monitoring to stay compliant.*

| Plane | Role | Key Functions |
|-------|------|---------------|
| **Control Plane** (Purview) | Runs the lifecycle | Discover → Prioritize → Evaluate → Bind Regulation → Monitor → Respond |
| **Evidence Plane** (Purview) | Continuously proves operation | Right controls operating effectively → Right evaluations for actor & jurisdiction → Report Drift with current evidence |

---

## V1 Scope (Target: Compliance Administrator)

### Objectives
- Continuous evaluation of AI Agents
- Unified interface displaying agents from various platforms
- Clear, prioritized insights for Compliance Admins with explainability
- Easy setup with minimal barriers
- Flexibility to incorporate custom evaluations

### Non-Goals (V1)
- Identifying and tracking AI Agents within the tenant environment
- Labeling agents as Compliant or non-compliant

### V1 Components

| Component | Definition | Demo Card |
|-----------|-----------|-----------|
| **Agent Inventory** | Repository of agents for continuous evaluation. Source: A365 Inventory | `card-agent-inventory` — SQLite source (A365 analog) |
| **Agent Priority** | Categorize agents: Immediate / Normal / Monitor / Unassessed | `card-agent-priority` — JSONata `$filter` compute |
| **Eval Pack** | List of evaluations per category with regulation mapping. Default baseline pack by Microsoft | `card-eval-pack` — 9-category baseline (Scope, Adherence, Determinism, Groundedness, Drift, Safety, Content Safety, Security, RAG) |
| **Eval Results** | Run results: per-agent pivot + aggregate stats | `card-eval-results` — SQLite pivot + stats queries |
| **Drift & Risk Report** | LLM-synthesized drift analysis from eval data | `card-drift-report` — Copilot source with projections |
| **Compliance Overview** | Executive summary highlighting top actions | `card-compliance-overview` — Copilot leaf consuming full DAG |
| **Remediation Tasks** | Owner actions from eval failures | `card-owner-actions` — SQLite task tracker |

### V1 Baseline Eval Pack

| # | Category | Targeted Evals | Mode | EUAI Regulation |
|---|----------|---------------|------|-----------------|
| 1 | Scope | Scope refusal | Generator-Verifier | Art 14 (Human oversight) |
| 2 | Adherence | JSON-validity, schema-validity, required field presence | Deterministic | Art 15 (Accuracy, robustness) |
| 3 | Determinism | BLEU, ROUGE-L | Deterministic | Art 15 (Accuracy, performance) |
| 4 | Groundedness | Groundedness, citation | LLM + Deterministic | Art 13 (Transparency), Art 15 |
| 5 | Regression & Drift | Drift evaluator after model change | Deterministic | Art 9 (Risk mgmt), Art 15 |
| 6 | Safety / Red-Teaming | Prompt injection, jailbreak | Generator-Verifier | Art 15 (Robustness) |
| 7 | Content Safety | Profanity, slur, harmful content detection | LLM + Deterministic | Art 15 (Harm mitigation), Art 5 |
| 7 | Security | Credential leakage | Generator-Verifier | Art 15 (System security) |
| 8 | RAG | Tool call presence, error rate, risky tool | Deterministic + Behavioral | Art 9, Art 13, Art 15 |

### V1 Constraints
- Evals run on sampled production traces
- Only high-priority (Immediate) agents get evals
- V1 targets Copilot declarative, studio, and foundry agents
- Agent trajectory instrumentation out of scope
- 20 evaluators target, 14 currently assessed

---

## V2 Scope (New: Agent Owner Persona + Monitoring Maturity)

### V2 Additions — Demo Cards

| V2 Feature | Demo Card | yaml-flow Capability Used | Product Vision |
|------------|-----------|--------------------------|----------------|
| **Agent Enrichment** | `card-enrichment` | `editable-table` + `card_data` + `provides` | Admin enriches agent metadata (priority override, risk notes, expedited flag). Addresses V1 risk: "agent inventory lacks metadata for risk scoring" |
| **Eval Setup & Regulation Binding** | `card-eval-setup` | `form` + `filter` + `provides` | Select eval packs (Baseline/EUAI/Custom), jurisdiction, run frequency. Downstream cards auto-recalculate for selected scope |
| **Owner Remediation Workflow** | `card-remediation-workflow` | `todo` + `actions` + `provides` | Interactive checklist for the **Agent Owner persona**. Notify/escalate buttons bridge compliance admin → developer. Completion state publishes back to DAG |
| **Drift Trend Monitor** | `card-drift-trend` | `ref` + form selector + `chart` | Historical eval pass-rates over 3 run dates. User toggles table ↔ chart view. Visualizes "Drift is Default" thesis with evidence |

### V2 DAG (extends V1)

```
card-agent-inventory (agents) ──→ card-enrichment (enriched_agents) ──→ [downstream override]
                               └──→ card-agent-priority (immediate_agents)
card-eval-pack (eval_categories) ──→ card-eval-setup (eval_setup, active_eval_categories)

card-eval-results (eval_results) ──→ card-drift-report (drift_summary, critical_findings, remediation)
                                  └──→ card-drift-trend (eval_trend)
                                  └──→ card-remediation-workflow (remediation_progress)
                                        ↑ also requires: immediate_agents

card-compliance-overview (leaf — consumes full DAG)
card-owner-actions (leaf — standalone from DB)
```

### How yaml-flow Capabilities Map to Product Vision

| yaml-flow Pattern | Product Analogy |
|-------------------|-----------------|
| **Reactive DAG** (`provides`/`requires`) | Control Plane lifecycle — data flows automatically from Discover through Respond |
| **`runtime-out/data-objects/`** tokens | Evidence Plane — each published token is auditable evidence |
| **Source auto-recompute on change** | "Drift is Default" — when model changes, evals re-run, drift cascades through DAG |
| **`editable-table` → `provides`** | Admin enrichment flow — overrides propagate without manual refresh |
| **`form` → downstream filter** | Eval pack/regulation binding — configuration choice restructures the experience |
| **`todo` + `actions`** | Owner collaboration — task tracking + notification actions in the compliance flow |
| **`ref` + form selector** | Adaptive UX — same data, user chooses visualization (table/chart/editable-table) |
| **`copilot` source with `projections`** | LLM-as-evaluator — synthesize findings from structured data, explain drift, generate remediation |
| **Multi-board (cpm + cpmV2)** | Per-regulation experiences — EUAI board, custom pack board, shared inventory |
| **SQLite → swap to API** | Demo uses SQLite; product uses A365 API. Card logic is unchanged — only `source_defs` swap |

### V2 Priorities (Recommended Order)

1. **Enrichment + Eval Setup** — close V1 metadata gap and make regulation binding interactive
2. **Owner Workflow** — add second persona (Agent Developer/Owner) with actionable remediation
3. **Drift Trend** — visualize continuous monitoring with historical evidence
4. **Safety/Red-Teaming + RAG evals** — close V1 feasibility gaps (categories 6 & 8)
5. **EUAI Regulation Pack** — ship as a separate board/experience
6. **Compliance Evidence Export** — auditor-facing reports generated from DAG tokens

---

## Running the Demo

```bash
# Seed the database (V1 + V2 historical data)
npm run seed-cpmV2

# Start the server
npm start

# Open in browser — select "CPM V2" from board dropdown
# http://localhost:8000
```

Board key in dropdown: **CPM V2** (key: `cpmV2`)

V1 board remains available as **CPM** (key: `cpm`) for comparison.
