# TwinOps judge guide

TwinOps demonstrates evidence-based network repair: an AI planner proposes changes, an isolated twin tests them, deterministic gates evaluate the results and a human authorizes the exact tested change.

**[Watch the 2:58 demo on YouTube](https://youtu.be/wyze5IWUEC0).** It follows one real deployed run from the routing-fault click through Gemini investigation, twin tests, repair comparison, exact diff, owner-authorized approval, measured recovery and Proof Pack download. Waiting time is shortened. You can view this workflow without operating the shared lab or needing its approval credential.

The [sanitized run record](evidence/recorded-demo.json) preserves model-call provenance, approval binding and recovery checks even if the hosted instance's saved history is replaced. The [technical guide](TECHNICAL_GUIDE.md) explains the implementation and its limits.

## Open the prototype

- [TwinOps workbench](https://twinops-live-705406130795.europe-west1.run.app/workbench)
- [Metro Network](https://twinops-live-705406130795.europe-west1.run.app/metro/)
- [PDF pitch deck](TwinOps_Deck.pdf)
- [Submission overview](SUBMISSION.md)

The service can scale to zero, so wait for lab readiness after a cold start. Both applications share one lab across visitors. Coordinate a session with the project host before introducing a fault. The host provides approval access privately or performs that step during a guided session; the operator passcode is not published.

## Inspect without changing the lab

1. Open Metro. Check the last measurement time, customer journeys and safety guardrails. Healthy status means four measured journeys currently succeed; displayed customer counts are simulated.
2. Open the workbench. Confirm **Live backend**, a connected Metro Network and current measurements. **Runtime details** identifies the planner and twin. The deployment reviewed on 15 October 2026 reported Vertex AI / Gemini 2.5 Flash and an emulated Linux namespace lab.
3. The [health endpoint](https://twinops-live-705406130795.europe-west1.run.app/api/health) reports API health. The [configuration endpoint](https://twinops-live-705406130795.europe-west1.run.app/api/config) reports configured planner and twin readiness; it does not establish a successful model invocation.
4. Open **Recent incidents** if saved investigations exist. Saved evidence is read-only after restart and may disappear when the Cloud Run instance is replaced. The overview's animations and browser evaluation are deterministic examples.

## Follow a supported repair with the host

| Step | Action | Evidence to inspect |
|---|---|---|
| 1 | With the host's approval access ready and the shared lab idle, introduce a routing fault in Metro or the workbench controls | A measured outage appears; the incident is detected automatically |
| 2 | Open the detected investigation | Timestamped observations, source IDs and ranked hypotheses; the fault label remains sealed |
| 3 | Inspect **AI trace** | Actual provider/model calls, rejected output, latency/tokens and any runbook fallbacks; a model badge alone is insufficient |
| 4 | Follow reproduction and candidate tests | The twin reproduces symptoms; alternatives have restoration, regression, challenge and rollback evidence |
| 5 | Open **Decision review** | Proposed diff, evidence age, coverage, remaining uncertainty and individual gate results |
| 6 | Have the authorized host approve the exact tested change | Operator identity label, explicit acknowledgment and protected approval; target drift must invalidate stale approval |
| 7 | Wait for the outcome and revisit Metro | Fresh post-checks establish recovery while the negative controls remain intact |
| 8 | Download the Proof Pack | Incident/model provenance, selected and rejected changes, gate reasons, approval and outcome |

Candidate identities and behavior depend on the collected evidence and planner. An escalation or visible fallback is a valid observed result; do not relabel it as a successful Gemini repair. Historical runbook timings in the deck are not a timing promise for this hosted session.

## Check an unsupported fault

After the supported exercise is complete, introduce the **Link flap / Unsupported** control. TwinOps should stop without a proposed repair when the failure cannot be reproduced or is outside supported fidelity. Inspect the verdict and write log rather than assuming the expected outcome occurred. Reset only after the investigation has finished and the app offers the reset action.

## Leave the shared lab ready

If a passing candidate is awaiting a decision, have the authorized host approve or reject it before leaving. Reset is blocked during an active investigation; do not clear files or restart the instance to bypass ownership or recovery guards. If **Operator recovery** appears, stop the demo and let the host restore and verify the lab. A caller without approval access should use the read-only inspection above rather than start a fault exercise.

## Interpret the limits

The demo uses synthetic topology and incidents with real protocol traffic. There is no real customer or carrier production access. A passing verdict establishes evidence under the defined tests; it does not guarantee all production conditions are safe. History is ephemeral on Cloud Run, approval is a shared role credential, and operator time savings remain unmeasured.
