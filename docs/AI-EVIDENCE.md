# AI failure evidence

The publisher sends Gemini bounded diagnostic facts and the last 24 recorded
Playwright actions (input arguments omitted). It can explain up to 16 distinct
failure groups. These are recorded actions, not a reconstruction of missing steps.

`E2E_AI_VISUAL_EVIDENCE=true` enables already-published screenshots and a sampled
frame approximately two seconds before each selected video ends. This is enabled
in the publishing workflow; set the repository variable to `false` to disable it.
No entire videos, traces, DOM, headers or request bodies are uploaded. Auth/signup/
cleanup images are excluded. Checkout screenshots may contain test addresses or
other visible test data: use synthetic data in this public automation tenant.
Images are not automatically OCR-redacted. Do not enable this for private customer
recordings. The provider receives the same selected visual evidence as the public
report, subject to its data handling terms.

Limits: eight images total, 1.5 MB per image, 6 MB total, video source at most
25 MB, three seconds per frame decoder. Media extraction and the Gemini request
share a 120-second child-process deadline. Missing/oversized images or
unavailable decoding are omitted; provider failure never changes raw test results.
The report lists the images actually supplied, self-assessed confidence and a
suggested manual check. Reproduction suggestions are not verified reproductions.
Screenshots/video are untrusted evidence and cannot instruct the model.

This change applies to future report publication. Historical reports are immutable
unless explicitly republished; no tests or Slack notifications are triggered by
offline validation of this code.
