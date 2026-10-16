# TwinOps documentation

Start with the [project README](../README.md) for the problem, live applications and setup, or [watch the 3:00 showcase](https://youtu.be/0LjDHiUBy0Y).

| Read | Purpose |
|---|---|
| [Technical guide](TECHNICAL_GUIDE.md) | Architecture, investigation flow, approval boundary, run modes and limitations |
| [Demo walkthrough](JUDGE_GUIDE.md) | Inspect the hosted prototype and follow a controlled repair with the host |
| [Submission overview](SUBMISSION.md) | Problem, Google AI integration, implementation, evidence and intended impact |
| [Online submission deck](https://twinops-live-705406130795.europe-west1.run.app/deck) | The same 13 official-template slides, with keyboard navigation and readable explanations |
| [PDF submission deck](TwinOps_Deck.pdf) | Completed official competition template, including team, workflow, architecture, screenshots and evidence |
| [Editable submission deck](TwinOps_Deck.pptx) | PowerPoint source of the submission PDF |

## Evidence

- [Recorded hosted repair](evidence/recorded-demo.json): Gemini-call provenance, selected change, approval and measured recovery from the 15 October 2026 run shown in the current 3:00 video. Credentials and full approval tokens are omitted.
- [Foundation evaluation](evidence/foundation-evaluation.json): 320 deterministic model cases, including repairs and expected abstentions. This evaluates the runbook/model path, separately from the hosted Gemini demonstration.

The four files in `images/` show the product overview, workbench, Metro lab and architecture for the project README and submission overview. The repository keeps the current reader documentation and evidence; historical proposals and video production assets are outside this public documentation set.
