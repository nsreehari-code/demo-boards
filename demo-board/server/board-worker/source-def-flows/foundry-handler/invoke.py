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
import shutil
import sys
import time


def is_path_allowed(filepath, allowed_dirs):
    real = os.path.realpath(filepath)
    return any(real.startswith(os.path.realpath(d) + os.sep) or real == os.path.realpath(d)
               for d in allowed_dirs)


def tool_read_file(arguments, allowed_dirs):
    path = arguments.get("path", "")
    if not path:
        return json.dumps({"error": "path is required"})
    if not is_path_allowed(path, allowed_dirs):
        return json.dumps({"error": "access denied: path not in allowed directories"})
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(512_000)
        return json.dumps({"path": path, "content": content})
    except Exception as e:
        return json.dumps({"error": str(e)})


def tool_list_dir(arguments, allowed_dirs):
    path = arguments.get("path", "")
    if not path:
        return json.dumps({"error": "path is required"})
    if not is_path_allowed(path, allowed_dirs):
        return json.dumps({"error": "access denied: path not in allowed directories"})
    try:
        entries = []
        for name in sorted(os.listdir(path)):
            full = os.path.join(path, name)
            entries.append({"name": name, "type": "dir" if os.path.isdir(full) else "file"})
        return json.dumps({"path": path, "entries": entries})
    except Exception as e:
        return json.dumps({"error": str(e)})


def tool_patch_json_file(arguments, allowed_dirs):
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

    import re
    segments = re.split(r'\.|(?=\[)', json_path)
    segments = [s for s in segments if s]
    obj = data
    try:
        for seg in segments[:-1]:
            m = re.match(r'^\[(\d+)\]$', seg)
            if m:
                obj = obj[int(m.group(1))]
            else:
                obj = obj[seg]
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

    validation = _validate_card(filepath)
    if not validation.get("ok", True):
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
    import subprocess

    def _find_repo_root(start_dir):
        current = start_dir
        while True:
            if os.path.exists(os.path.join(current, "package.json")) and os.path.exists(os.path.join(current, "node_modules")):
                return current
            parent = os.path.dirname(current)
            if parent == current:
                return None
            current = parent

    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = _find_repo_root(script_dir)
    if not repo_root:
        return {"ok": True, "errors": []}

    cli_js = os.path.join(repo_root, "demo-board", "scripts", "yaml-flow", "board-live-cards-cli.mjs")
    node_bin = shutil.which("node")
    if not node_bin or not os.path.exists(cli_js):
        return {"ok": True, "errors": []}

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            card_json = f.read()
        result = subprocess.run(
            [node_bin, cli_js, "validate-card-preflight"],
            input=card_json,
            capture_output=True,
            text=True,
            timeout=10,
            cwd=repo_root,
        )
        if not result.stdout.strip():
            return {"ok": True, "errors": []}

        parsed = json.loads(result.stdout.strip())
        if parsed.get("status") == "success":
            data = parsed.get("data") or {}
            return {
                "ok": data.get("isValid", True),
                "errors": data.get("issues") or [],
            }

        return {"ok": False, "errors": [parsed.get("error") or "validation failed"]}
    except Exception:
        return {"ok": True, "errors": []}


def tool_read_pdf(arguments, allowed_dirs):
    filepath = arguments.get("path", "")
    pages = arguments.get("pages")
    if not filepath:
        return json.dumps({"error": "path is required"})
    if not is_path_allowed(filepath, allowed_dirs):
        return json.dumps({"error": "access denied: path not in allowed directories"})
    try:
        import fitz
    except ImportError:
        return json.dumps({"error": "PyMuPDF not installed. Run: pip install PyMuPDF"})
    try:
        doc = fitz.open(filepath)
        result_pages = []
        page_indices = pages if pages else range(len(doc))
        total_chars = 0
        for i in page_indices:
            if i < 0 or i >= len(doc):
                continue
            text = doc[i].get_text()
            total_chars += len(text)
            result_pages.append({"page": i, "text": text})
            if total_chars > 200_000:
                result_pages.append({"page": "truncated", "text": f"... output truncated at {total_chars} chars. Use 'pages' parameter to read specific pages."})
                break
        total_pages = len(doc)
        doc.close()
        return json.dumps({"path": filepath, "total_pages": total_pages, "pages": result_pages})
    except Exception as e:
        return json.dumps({"error": str(e)})


TOOL_HANDLERS = {
    "read_file": tool_read_file,
    "list_dir": tool_list_dir,
    "read_pdf": tool_read_pdf,
    "patch_json_file": tool_patch_json_file,
}


def build_function_tools():
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
        FunctionToolDefinition(
            function=FunctionDefinition(
                name="read_pdf",
                description="Extract text from a PDF file. Returns page-by-page text content. Use for reading compliance documents, reports, policies, or any PDF in the allowed directories.",
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute path to the PDF file to read."
                        },
                        "pages": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "description": "Optional list of 0-based page numbers to read. If omitted, reads all pages."
                        }
                    },
                    "required": ["path"]
                }
            )
        ),
    ]


def run_agent_with_tools(client, agent_id, user_prompt, allowed_dirs, max_iterations=10):
    from azure.ai.agents.models import (
        AgentThreadCreationOptions,
        ThreadMessageOptions,
        MessageRole,
        ToolOutput,
    )

    tools = build_function_tools() if allowed_dirs else []

    if allowed_dirs:
        dirs_desc = "\n".join(f"  - {d}" for d in allowed_dirs)
        user_prompt += (
            f"\n\nYou have access to local file tools (read_file, list_dir) "
            f"for browsing these directories:\n{dirs_desc}"
        )

    run = client.create_thread_and_run(
        agent_id=agent_id,
        thread=AgentThreadCreationOptions(
            messages=[ThreadMessageOptions(role=MessageRole.USER, content=user_prompt)]
        ),
        tools=tools,
    )
    thread_id = run.thread_id

    for _ in range(max_iterations):
        while run.status in ("queued", "in_progress"):
            time.sleep(1)
            run = client.runs.get(thread_id=thread_id, run_id=run.id)

        if run.status == "completed":
            break

        if run.status == "requires_action":
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

            run = client.runs.submit_tool_outputs(
                thread_id=thread_id,
                run_id=run.id,
                tool_outputs=outputs,
            )
            continue

        break

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

    try:
        from azure.identity import DefaultAzureCredential
        from azure.ai.agents import AgentsClient
    except ImportError as e:
        print(
            f"ERROR: Missing required package: {e.name}. "
            "Install with: pip install -r server/board-worker/source-def-flows/foundry-handler/requirements.txt",
            file=sys.stderr,
        )
        sys.exit(1)

    credential = DefaultAzureCredential()
    client = AgentsClient(endpoint=endpoint, credential=credential)

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

    try:
        client.threads.delete(thread_id)
    except Exception:
        pass

    if run.status != "completed":
        print(f"ERROR: Agent run {run.status}: {run.last_error}", file=sys.stderr)
        sys.exit(1)

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