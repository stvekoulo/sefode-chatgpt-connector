# SEFODE ChatGPT Connector

An MIT-licensed, open-source connector for using eligible ChatGPT plan access
from self-hosted automation. This is an independent project, not an OpenAI product.
It does not contain prospect records, business configuration, mailbox credentials,
ChatGPT tokens or an API-key billing fallback.

**Status: initial OAuth and inference client; live account admission not yet verified.**
The n8n integration and production daemon are not implemented in this initial version.
Publishing the source does not guarantee access, available models or uninterrupted quotas.

## Requirements

Node.js 22+, an eligible ChatGPT account, and explicit user authorization.
Read the official availability rules before use:
https://developers.openai.com/siwc/quickstart

## Local sign-in

```sh
npm ci
npm test
npm run login
```

The tool creates a private `~/.sefode-chatgpt` directory. Set `SEFODE_AUTH_DIR`
to use another directory **outside this repository**. Open the URL saved in
`authorization-url.txt` in your local browser, then review and authorize
**SEFODE Prospection Connector** yourself.

OAuth uses a loopback listener, PKCE, state, nonce, JWT signature and issuer/audience
validation. Permission `chatgpt.tokens.use.direct` is required. Tokens are never
printed. Unix files use mode 0600; on Windows the auth directory inherits no ACLs
and grants access to the current Windows account. Protect backups as secrets too.

The first login creates a new registration. This version intentionally refuses
to overwrite an existing account. Do not delete or replace sessions blindly.

## Self-hosted VM

Complete login locally using this same tool. Transfer only the selected protected
credential file to the VM over SSH. Create a separate persistent host ID on the VM;
do not copy the local host identity. The VM becomes the sole token-refresh owner.
Never run simultaneous refreshers against the same session. This client serializes
refreshes inside one process; multiple processes require external locking.

Official instructions:
https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms

## Inference

`src/client.js` exports `models()` and `respond({model, input, instructions, webSearch})`.
Choose an account-visible model slug. The model-list response is interpreted using
the documented SIWC `models` list, not the unrelated API-key catalog format.
Requests use the public Responses endpoint, `store:false`, `stream:true` and an
input array. A stream counts as successful only after `response.completed`.
Failed, incomplete, interrupted and quota-limited responses throw errors.

Web search is optional and remains subject to account/model policy. There is no
email-sending capability, public HTTP listener or external secret store in this release.

Documentation:
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

## Security boundaries

Do not put tokens in workflow JSON, source control, logs or URLs. Do not expose
this client directly to the Internet or share registrations between different users.
Revoke compromised app access in ChatGPT Settings. Test admission and quota behavior
before enabling unattended work. No test here sends email or calls live inference.
