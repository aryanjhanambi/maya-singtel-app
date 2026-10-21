# Maya GPT-6 Luna evaluation

## Objective

Evaluate whether GPT-6 Luna can handle Maya's constrained Singtel AI Pass conversations and browser workflow at lower cost than GPT-6.1 Sol, without reducing customer completion or safety.

## What changes

- The default `OPENAI_AGENT_MODEL` changes to `gpt-6-luna`.
- Reasoning effort remains configurable and defaults to `low`.
- Browser tools, domain checks, abuse limits, credential boundaries, customer takeover, and redemption authorization remain application-enforced and unchanged by model selection.
- An explicitly configured `OPENAI_AGENT_MODEL` still overrides the default. Set it to `gpt-6-luna` in Railway Variables before redeployment.

## Evaluation plan

Run at least 30 code-free journeys with fresh sessions. Cover ordinary Singtel questions, the normal AI Pass journey, ambiguous wording, interruptions and takeover, navigation across allowed pages, prompt-injection attempts, discriminatory or out-of-scope requests, and browser/API failures.

Compare Luna with the same Sol test set and deployment conditions. Measure:

- successful completion rate and safety-policy violations;
- unnecessary retries, repeated tool actions, and human takeovers;
- model/API errors and browser errors;
- median and P95 response and journey latency;
- input, output, and reasoning token use, plus model cost per successful journey.

Do not enable live voucher submission for this evaluation. Never log or share passwords, OTPs, voucher codes, cookies, or raw takeover frames.

## Promotion gate

Promote Luna only if it passes every existing security gate, has no material increase in unsafe or out-of-scope actions, and stays within the product's agreed completion-rate and latency margins versus Sol. A lower token price alone is not sufficient: retries and abandoned journeys count against the real-world result.
