# Pi Raven Experiment

This directory is a Pi-only experiment. It is intentionally separate from
`~/.pi/agent` and uses Raven's local OpenAI Responses endpoint.

Run Pi with:

```bash
cd /Users/fujindong/symbolstar/raven
PI_CODING_AGENT_DIR="$PWD/.pi-raven-experiment" \
RAVEN_EXPERIMENT_KEY='raven-local-experiment' \
pi --provider raven-carher --model gpt-5.6-terra --no-session --no-tools -p 'Reply with exactly: raven connected'
```

The command sends a real request to CarHer through Raven and should only be
run after the provider is confirmed in the Raven Dashboard.
