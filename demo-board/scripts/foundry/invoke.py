#!/usr/bin/env python3
"""
invoke.py — Call an Azure AI Foundry Agent using Managed Identity (DefaultAzureCredential).

Usage:
    python invoke.py --input <request.json> --output <result.json>

--input JSON shape:
{
  "endpoint":       "https://sz-foundry.services.ai.azure.com/api/projects/sz-project",
  "agent_id":       "asst_IMDJiVnL9fS0QbttDXKxN5lF",
  "prompt":         "Interpolated user prompt text",
  "result_shape":   { "key": null }          (optional — validates top-level keys)
}

Auth: Uses azure.identity.DefaultAzureCredential (MI in prod, az login locally).
No API keys required.
"""

import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser(description="Azure AI Foundry Agent invocation via MI")
    parser.add_argument("--input", required=True, help="Path to request JSON file")
    parser.add_argument("--output", required=True, help="Path to write result JSON")
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        req = json.load(f)

    endpoint = req.get("endpoint")
    agent_id = req.get("agent_id")
    prompt = req.get("prompt", "")
    result_shape = req.get("result_shape")

    if not endpoint:
        print("ERROR: endpoint is required", file=sys.stderr)
        sys.exit(1)
    if not agent_id:
        print("ERROR: agent_id is required", file=sys.stderr)
        sys.exit(1)
    if not prompt:
        print("ERROR: prompt is required", file=sys.stderr)
        sys.exit(1)

    # Import Azure libs (fail fast with clear message if missing)
    try:
        from azure.identity import DefaultAzureCredential
        from azure.ai.agents import AgentsClient
        from azure.ai.agents.models import AgentThreadCreationOptions, ThreadMessageOptions, MessageRole
    except ImportError as e:
        print(
            f"ERROR: Missing required package: {e.name}. "
            "Install with: pip install azure-identity azure-ai-projects azure-ai-agents",
            file=sys.stderr,
        )
        sys.exit(1)

    # Authenticate via MI / az login
    credential = DefaultAzureCredential()

    # Connect to Foundry agents
    client = AgentsClient(endpoint=endpoint, credential=credential)

    # If result_shape is specified, append a JSON hint to the prompt
    user_prompt = prompt
    if result_shape:
        user_prompt += (
            "\n\nIMPORTANT: Return your answer as valid JSON with these top-level keys: "
            + ", ".join(result_shape.keys())
            + ". No markdown fences, no extra text outside the JSON."
        )

    # Create thread with initial message and run the agent in one call
    run = client.create_thread_and_process_run(
        agent_id=agent_id,
        thread=AgentThreadCreationOptions(
            messages=[ThreadMessageOptions(role=MessageRole.USER, content=user_prompt)]
        ),
    )

    if run.status == "failed":
        print(f"ERROR: Agent run failed: {run.last_error}", file=sys.stderr)
        # Clean up thread
        try:
            client.threads.delete(run.thread_id)
        except Exception:
            pass
        sys.exit(1)

    # Get the last assistant message text
    content_obj = client.messages.get_last_message_text_by_role(
        thread_id=run.thread_id, role="assistant"
    )
    content = content_obj.text.value if hasattr(content_obj, 'text') else str(content_obj)

    # Clean up thread
    try:
        client.threads.delete(run.thread_id)
    except Exception:
        pass

    # Try to parse as JSON
    result = content
    try:
        parsed = json.loads(content)
        if result_shape and isinstance(parsed, dict):
            missing = [k for k in result_shape if k not in parsed]
            if missing:
                print(
                    f"WARNING: response missing expected keys: {missing}",
                    file=sys.stderr,
                )
        result = parsed
    except json.JSONDecodeError:
        # Return raw text if not valid JSON
        pass

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
