---
'@metorial/mcp-session': patch
'@metorial/openai': patch
'@metorial/openai-compatible': patch
'@metorial/mistral': patch
---

Keep tool schemas faithful in strict mode: optional properties become nullable instead of mandatory, `$defs` are kept, tools that strict mode cannot express are sent with `strict: false`, and the OpenAI Responses adapter now sends the strict schema.
