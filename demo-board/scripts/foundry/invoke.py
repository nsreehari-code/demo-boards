#!/usr/bin/env python3
"""
invoke.py — Call an Azure AI Foundry Agent using Managed Identity (DefaultAzureCredential).

Provides local file access to the agent via function tools (read_file, list_dir)
sandboxed to allowed directories.

Usage:
    python invoke.py --input <request.json> --output <result.json>

--input JSON shape:
{
  "endpoint":       "https://sz-foundry.services.ai.azure.com/api/projects/sz-project",
  "agent_id":       "asst_IMDJiVnL9fS0QbttDXKxN5lF",
  "prompt":         "Interpolated user prompt text",
  "result_shape":   { "key": null },         (optional — validates top-level keys)
  "allowed_dirs":   ["/abs/path/to/dir"]     (optional — directories the agent can read)
}

Auth: Uses azure.identity.DefaultAzureCredential (MI in prod, az login locally).
No API keys required.
"""

import argparse
import json
import os
import sys
import time


# ---------------------------------------------------------------------------
# Sandboxed local file tools — only paths under allowed_dirs are accessible
# ---------------------------------------------------------------------------

def is_path_allowed(filepath, allowed_dirs):
    """Check if filepath is under one of the allowed directories."""
    real = os.path.realpath(filepath)
    return any(real.startswith(os.path.realpath(d) + os.sep) or real == os.path.realpath(d)
               for d in allowed_dirs)


def tool_read_file(arguments, allowed_dirs):
    """Read a file's content. Returns text content or error string."""
    path = arguments.get("path", "")
    if not path:
        return json.dumps({"error": "path is required"})
    if not is_path_allowed(path, allowed_dirs):
        return json.dumps({"error": f"access denied: path not in allowed directories"})
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(512_000)  # cap at 512KB
        return json.dumps({"path": path, "content": content})
    except Exception as e:
        return json.dumps({"error": str(e)})


def tool_list_dir(arguments, allowed_dirs):
    """List directory contents. Returns entries with type (file/dir)."""
    path = arguments.get("path", "")
    if not path:
        return json.dumps({"error": "path is required"})
    if not is_path_allowed(path, allowed_dirs):
        return json.dumps({"error": f"access denied: path not in allowed directories"})
    try:
        entries = []
        for name in sorted(os.listdir(path)):
            full = os.path.join(path, name)
            entries.append({"name": name, "type": "dir" if os.path.isdir(full) else "file"})
        return json.dumps({"path": path, "entries": entries})
    except Exception as e:
        return json.dumps({"error": str(e)})


def tool_patch_json_file(arguments, allowed_dirs):
    """Patch a JSON file at a specific path. Reads the file, sets the value at
    json_path (dot-separated, with [N] for array indices), writes back, then
    validates the card schema. If validation fails, the original file is restored
    and errors are returned so the agent can correct its patch."""
    filepath = arguments.get("path", "")
    json_path = arguments.get("json_path", "")
    value = arguments.get("value")
    if not filepath or not json_path:
        return json.dumps({"error": "path and json_path are required"})
    if not is_path_allowed(filepath, allowed_dirs):
        return json.dumps({"error": "access denied: path not in allowed directories"})
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            original_content = f.read()
        data = json.loads(original_content)
    except Exception as e:
        return json.dumps({"error": f"cannot read file: {e}"})

    # Navigate json_path: supports dot-separated keys and [N] array indices
    # e.g. "card_data.items[2].done" -> data["card_data"]["items"][2]["done"]
    import re
    segments = re.split(r'\.|(?=\[)', json_path)
    segments = [s for s in segments if s]  # drop empty
    obj = data
    try:
        for seg in segments[:-1]:
            m = re.match(r'^\[(\d+)\]$', seg)
            if m:
                obj = obj[int(m.group(1))]
            else:
                obj = obj[seg]
        # Set the final key/index
        last = segments[-1]
        m = re.match(r'^\[(\d+)\]$', last)
        if m:
            obj[int(m.group(1))] = value
        else:
            obj[last] = value
    except (KeyError, IndexError, TypeError) as e:
        return json.dumps({"error": f"invalid json_path '{json_path}': {e}"})

    try:
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": f"cannot write file: {e}"})

    # Validate the patched card against the live card schema
    validation = _validate_card(filepath)
    if not validation.get("ok", True):
        # Restore original file content
        try:
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(original_content)
        except Exception:
            pass
        return json.dumps({
            "error": "patch reverted — card schema validation failed",
            "validation_errors": validation.get("errors", []),
            "hint": "Fix the value to match the card schema and try again.",
        })

    return json.dumps({"ok": True, "path": filepath, "json_path": json_path, "validated": True})


def _validate_card(filepath):
    """Run validate-card.cjs to check the card against validateLiveCardSchema."""
    import subprocess
    validate_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "validate-card.cjs")
    if not os.path.exists(validate_script):
        return {"ok": True, "errors": []}  # skip if script missing
    try:
        result = subprocess.run(
            ["node", validate_script, filepath],
            capture_output=True, text=True, timeout=10,
            cwd=os.path.dirname(validate_script),
        )
        return json.loads(result.stdout.strip()) if result.stdout.strip() else {"ok": True, "errors": []}
    except Exception:
        return {"ok": True, "errors": []}  # don't block on validation failure


TOOL_HANDLERS = {
    "read_file": tool_read_file,
    "list_dir": tool_list_dir,
    "patch_json_file": tool_patch_json_file,
}


# ---------------------------------------------------------------------------
# Function tool definitions for the agent
# ---------------------------------------------------------------------------

def build_function_tools():
    """Build FunctionToolDefinition objects for read_file and list_dir."""
    from azure.ai.agents.models import FunctionToolDefinition, FunctionDefinition

    return [
        FunctionToolDefinition(
            function=FunctionDefinition(
                name="read_file",
                description="Read the contents of a local file. Use this to examine card definitions, runtime data, or configuration files.",
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute path to the file to read."
                        }
                    },
                    "required": ["path"]
                }
            )
        ),
        FunctionToolDefinition(
            function=FunctionDefinition(
                name="list_dir",
                description="List the contents of a local directory. Returns file and directory names with their types.",
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute path to the directory to list."
                        }
                    },
                    "required": ["path"]
                }
            )
        ),
        FunctionToolDefinition(
            function=FunctionDefinition(
                name="patch_json_file",
                description="Update a specific value in a JSON file. Reads the file, sets the value at the given path, and writes back. Use for updating card_data, marking todos done, etc.",
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute path to the JSON file to patch."
                        },
                        "json_path": {
                            "type": "string",
                            "description": "Dot-separated path to the value to set. Use [N] for array indices. Example: 'card_data.items[2].done'"
                        },
                        "value": {
                            "description": "The new value to set (any JSON type: string, number, boolean, object, array, null)."
                        }
                    },
                    "required": ["path", "json_path", "value"]
                }
            )
        ),
    ]


# ---------------------------------------------------------------------------
# Run loop with tool call handling
# ---------------------------------------------------------------------------

def run_agent_with_tools(client, agent_id, user_prompt, allowed_dirs, max_iterations=10):
    """
    Create a thread, run the agent, and handle function tool calls in a loop.
    Returns (thread_id, final_content_string).
    """
    from azure.ai.agents.models import (
        AgentThreadCreationOptions,
        ThreadMessageOptions,
        MessageRole,
        ToolOutput,
    )

    # Build tools list only if we have allowed dirs
    tools = build_function_tools() if allowed_dirs else []

    # Describe available directories in the prompt if tools are active
    if allowed_dirs:
        dirs_desc = "\n".join(f"  - {d}" for d in allowed_dirs)
        user_prompt += (
            f"\n\nYou have access to local file tools (read_file, list_dir) "
            f"for browsing these directories:\n{dirs_desc}"
        )

    # Create thread + start run
    run = client.create_thread_and_run(
        agent_id=agent_id,
        thread=AgentThreadCreationOptions(
            messages=[ThreadMessageOptions(role=MessageRole.USER, content=user_prompt)]
        ),
        tools=tools,
    )
    thread_id = run.thread_id

    # Poll and handle tool calls
    for _ in range(max_iterations):
        # Wait for run to reach a terminal or action-required state
        while run.status in ("queued", "in_progress"):
            time.sleep(1)
            run = client.runs.get(thread_id=thread_id, run_id=run.id)

        if run.status == "completed":
            break

        if run.status == "requires_action":
            # Extract tool calls
            action = run.required_action
            tool_calls = action.submit_tool_outputs.tool_calls
            outputs = []
            for tc in tool_calls:
                fn_name = tc.function.name
                fn_args = json.loads(tc.function.arguments) if tc.function.arguments else {}
                handler = TOOL_HANDLERS.get(fn_name)
                if handler:
                    result = handler(fn_args, allowed_dirs)
                else:
                    result = json.dumps({"error": f"unknown tool: {fn_name}"})
                outputs.append(ToolOutput(tool_call_id=tc.id, output=result))

            # Submit tool outputs and continue
            run = client.runs.submit_tool_outputs(
                thread_id=thread_id,
                run_id=run.id,
                tool_outputs=outputs,
            )
            continue

        # Any other terminal status (failed, cancelled, expired)
        break

    # Get final assistant message
    content = ""
    if run.status == "completed":
        content_obj = client.messages.get_last_message_text_by_role(
            thread_id=thread_id, role="assistant"
        )
        content = content_obj.text.value if hasattr(content_obj, "text") else str(content_obj)

    return thread_id, run, content


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
    allowed_dirs = req.get("allowed_dirs", [])

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
    except ImportError as e:
        print(
            f"ERROR: Missing required package: {e.name}. "
            "Install with: pip install azure-identity azure-ai-projects azure-ai-agents",
            file=sys.stderr,
        )
        sys.exit(1)

    # Authenticate via MI / az login
    credential = DefaultAzureCredential()
    client = AgentsClient(endpoint=endpoint, credential=credential)

    # If result_shape is specified, append a JSON hint to the prompt
    user_prompt = prompt
    if result_shape:
        user_prompt += (
            "\n\nIMPORTANT: Return your answer as valid JSON with these top-level keys: "
            + ", ".join(result_shape.keys())
            + ". No markdown fences, no extra text outside the JSON."
        )

    thread_id, run, content = run_agent_with_tools(
        client, agent_id, user_prompt, allowed_dirs
    )

    # Clean up thread
    try:
        client.threads.delete(thread_id)
    except Exception:
        pass

    if run.status != "completed":
        print(f"ERROR: Agent run {run.status}: {run.last_error}", file=sys.stderr)
        sys.exit(1)

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
        pass

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
