#!/usr/bin/env python3
"""
foundry-chat/invoke.py — Foundry agent tool-loop driver for chat.

Reads a single JSON request from stdin:
{
  "endpoint":            "<foundry project endpoint>",
  "agent_id":            "<foundry agent id>",
  "system_instructions": "<combined instructions+skills>",
  "user_prompt":         "<turn transcript prompt>",
  "card_id":             "<card-id>",
  "board_id":            "<board-id>",
  "log_id":              "<opaque log id>",
  "turn_id":             "<turn id>",
  "mcp_server_url":      "<http://127.0.0.1:7801/mcp>",
  "existing_thread_id":  "<reusable Foundry thread id> | ''",
  "output_file":         "<abs path of agent-output.txt> | ''",
  "timeout_seconds":     <int>
}

Behavior:
- Connects to the local MCP server, lists liveboards.* and lore.* tools, and
  registers each as a Foundry function tool with the MCP-provided JSON schema.
- Creates or reuses a per-cardId Foundry thread.
- Runs the agent with system_instructions as additional_instructions, posts the
  user_prompt as the user message, then enters a poll loop:
    * queued / in_progress  -> sleep and poll
    * requires_action       -> execute each tool call via the MCP server and
                              submit tool outputs
    * completed             -> done (assistant reply is staged via
                              liveboards.stage-ai-response-and-any-attachments
                              which the agent calls as its final tool)
    * failed / cancelled / expired -> exit 1
- Emits human-readable JSONL progress lines on stdout (the Node wrapper appends
    them to agent-output.txt).
"""

import asyncio
import json
import os
import sys
import time
import traceback
from typing import Any, Dict, List, Optional


EXPOSED_TOOL_PREFIXES_DEFAULT = ("liveboards.", "lore.")
TERMINAL_RUN_STATUSES = {"completed", "failed", "cancelled", "expired"}


def _shorten_text(value: Any, limit: int = 220) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]}...(+{len(text) - limit} chars)"


def _format_progress_line(record: Dict[str, Any]) -> str:
    stage = str(record.get("stage") or "progress").strip() or "progress"

    if stage == "connect-mcp":
        prefixes = record.get("exposed_prefixes") or []
        suffix = f" Exposed prefixes: {', '.join(prefixes)}." if prefixes else ""
        return f"Connecting to MCP server at {record.get('url', '')}.{suffix}"

    if stage == "tools-discovered":
        return f"Discovered {record.get('count', 0)} tools from MCP."

    if stage == "thread-resolved":
        return (
            f"Resolved thread for card {record.get('card_id', '')}. "
            f"thread-resolved: thread_id={record.get('thread_id', '')}; card_id={record.get('card_id', '')}"
        )

    if stage == "run-started":
        return f"Started Foundry run {record.get('run_id', '')}."

    if stage == "tool-call":
        name = record.get("name", "")
        args_preview = _shorten_text(record.get("args_preview", ""), 260)
        return f"Invoking '{name}' with {args_preview}."

    if stage == "final-reply-staged":
        card_id = str(record.get("card_id") or "").strip()
        card_suffix = f" for card {card_id}" if card_id else ""
        return (
            f"Staged final reply{card_suffix}. "
            f"Run {record.get('run_id', '')} on thread {record.get('thread_id', '')} "
            f"will stop after this stage."
        )

    if stage == "run-completed":
        if record.get("final_reply_staged"):
            return f"Completed Foundry run {record.get('run_id', '')} after staging the final reply."
        return f"Completed Foundry run {record.get('run_id', '')}."

    interesting_parts = []
    for key, value in record.items():
        if key in {"stage", "ts"}:
            continue
        interesting_parts.append(f"{key}={_shorten_text(value, 120)}")
    suffix = f" Details: {'; '.join(interesting_parts)}." if interesting_parts else ""
    return f"{stage}.{suffix}"


def _emit(record: Dict[str, Any]) -> None:
    record.setdefault("ts", time.strftime("%Y-%m-%dT%H:%M:%S"))
    line = _format_progress_line(record)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _sanitize_function_name(name: str) -> str:
    # Foundry function names must match ^[a-zA-Z0-9_-]{1,64}$. liveboards tools
    # already use dots which are not allowed -> swap to underscores. Keep a
    # reverse map so we can map calls back to the real MCP tool name.
    safe = "".join(c if c.isalnum() or c in ("_", "-") else "_" for c in name)
    return safe[:64]


def _mcp_schema_to_function_parameters(schema: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if isinstance(schema, dict) and schema.get("type"):
        return schema
    return {"type": "object", "properties": {}}


async def _mcp_session(mcp_url: str):
    """Open an MCP session over Streamable HTTP. Returns an async context manager."""
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    return streamablehttp_client(mcp_url), ClientSession


async def _list_mcp_tools(mcp_url: str, exposed_prefixes: tuple) -> List[Dict[str, Any]]:
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    out: List[Dict[str, Any]] = []
    async with streamablehttp_client(mcp_url) as (read_stream, write_stream, _close):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            tools_result = await session.list_tools()
            for tool in tools_result.tools:
                if exposed_prefixes and not tool.name.startswith(exposed_prefixes):
                    continue
                out.append({
                    "name": tool.name,
                    "description": tool.description or "",
                    "input_schema": tool.inputSchema if isinstance(tool.inputSchema, dict) else {},
                })
    return out


async def _call_mcp_tool(mcp_url: str, tool_name: str, arguments: Dict[str, Any]) -> str:
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    async with streamablehttp_client(mcp_url) as (read_stream, write_stream, _close):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            result = await session.call_tool(tool_name, arguments=arguments)
            # Prefer structured content; fall back to concatenated text blocks.
            structured = getattr(result, "structuredContent", None)
            if structured is not None:
                return json.dumps(structured, ensure_ascii=False)
            content = getattr(result, "content", None) or []
            chunks: List[str] = []
            for entry in content:
                text_value = getattr(entry, "text", None)
                if isinstance(text_value, str):
                    chunks.append(text_value)
            if chunks:
                return "".join(chunks)
            if getattr(result, "isError", False):
                return json.dumps({"error": f"{tool_name} returned isError with no text"})
            return ""


def _build_function_tools(tools_meta: List[Dict[str, Any]]):
    from azure.ai.agents.models import FunctionToolDefinition, FunctionDefinition

    defs = []
    name_map: Dict[str, str] = {}
    for t in tools_meta:
        safe = _sanitize_function_name(t["name"])
        name_map[safe] = t["name"]
        defs.append(
            FunctionToolDefinition(
                function=FunctionDefinition(
                    name=safe,
                    description=t["description"][:1024] if t["description"] else f"MCP tool {t['name']}",
                    parameters=_mcp_schema_to_function_parameters(t["input_schema"]),
                )
            )
        )
    return defs, name_map


def _cancel_active_runs_on_thread(client, thread_id: str) -> bool:
    """Cancel any non-terminal runs on the thread so a fresh message can be posted.

    Foundry rejects new messages while a run is queued/in_progress/requires_action.
    A crashed prior attempt can leave the thread locked; cancel + brief wait clears it.
    """
    try:
        runs_iter = client.runs.list(thread_id=thread_id)
    except Exception:
        return False
    active_ids = []
    try:
        for run in runs_iter:
            status = getattr(run, "status", "")
            if status and status not in TERMINAL_RUN_STATUSES:
                active_ids.append(run.id)
            if len(active_ids) >= 5:
                break
    except Exception:
        pass
    if not active_ids:
        return True
    for run_id in active_ids:
        try:
            client.runs.cancel(thread_id=thread_id, run_id=run_id)
        except Exception:
            continue
        cleared = False
        for _ in range(20):
            try:
                r = client.runs.get(thread_id=thread_id, run_id=run_id)
                if getattr(r, "status", "") in TERMINAL_RUN_STATUSES:
                    cleared = True
                    break
            except Exception:
                cleared = True
                break
            time.sleep(0.5)
        if not cleared:
            return False
    return True


def _cancel_run_if_active(client, thread_id: str, run_id: str) -> bool:
    if not run_id:
        return False
    try:
        run = client.runs.get(thread_id=thread_id, run_id=run_id)
        if getattr(run, "status", "") in TERMINAL_RUN_STATUSES:
            return True
    except Exception:
        return False

    try:
        client.runs.cancel(thread_id=thread_id, run_id=run_id)
    except Exception:
        return False

    for _ in range(20):
        try:
            run = client.runs.get(thread_id=thread_id, run_id=run_id)
            if getattr(run, "status", "") in TERMINAL_RUN_STATUSES:
                return True
        except Exception:
            return True
        time.sleep(0.5)
    return False


def _merge_liveboards_runtime_handles(
    tool_name: str,
    fn_args: Dict[str, Any],
    *,
    board_id: str,
    card_id: str,
    log_id: str,
    turn_id: str,
) -> Dict[str, Any]:
    """Inject authoritative runtime handles before calling liveboards.* tools.

    This is the control-plane guardrail for thread reuse: the model can inspect
    prior turns in the Foundry thread, but the actual MCP call still receives
    the current turn's runtime handles from the wrapper.
    """
    args = dict(fn_args) if isinstance(fn_args, dict) else {}
    if not tool_name.startswith("liveboards."):
        return args

    legacy_to_supported = {
        "boardId": "board_id",
        "cardId": "card_id",
        "logId": "log_id",
        "turnId": "turn_id",
        "turn-id": "turn_id",
        "tail-turns": "tail_turns",
        "all-turns": "all_turns",
        "tail-turns-before-id": "tail_turns_before_id",
    }
    for legacy_key, supported_key in legacy_to_supported.items():
        if legacy_key in args and supported_key not in args:
            args[supported_key] = args[legacy_key]

    if board_id:
        args["board_id"] = board_id
    if log_id:
        args["log_id"] = log_id

    if tool_name == "liveboards.stage-ai-response-and-any-attachments":
        # Final reply must land on the current card/turn even when the agent
        # has inspected other cards during discovery.
        if card_id:
            args["card_id"] = card_id
        if turn_id:
            args["turn_id"] = turn_id

    return args


def _resolve_thread_id(client, existing_thread_id: str) -> str:
    """Return a usable thread id, reusing an existing one when it is clear."""
    candidate = (existing_thread_id or "").strip()
    if candidate:
        try:
            client.threads.get(thread_id=candidate)
            if _cancel_active_runs_on_thread(client, candidate):
                return candidate
        except Exception:
            pass
    thread = client.threads.create()
    return thread.id


def _final_reply_observed(text: str, log_id: str) -> bool:
    # When the agent calls liveboards.stage-ai-response-and-any-attachments
    # successfully, we record that as the finalization signal. _tool_loop
    # already tracks this via the function-call side; this helper is only used
    # if/when we want to inspect assistant text directly.
    return bool(text) and log_id in text  # placeholder; not used today


def main() -> int:
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except Exception as e:
        print(f"ERROR: invalid stdin JSON: {e}", file=sys.stderr)
        return 1

    endpoint = req.get("endpoint", "").strip()
    agent_id = req.get("agent_id", "").strip()
    system_instructions = req.get("system_instructions", "")
    user_prompt = req.get("user_prompt", "")
    board_id = req.get("board_id", "")
    card_id = req.get("card_id", "")
    log_id = req.get("log_id", "")
    turn_id = req.get("turn_id", "")
    mcp_server_url = req.get("mcp_server_url", "").strip()
    existing_thread_id = req.get("existing_thread_id", "")
    timeout_seconds = int(req.get("timeout_seconds") or 300)

    raw_prefixes = req.get("exposed_mcp_tool_prefixes")
    if isinstance(raw_prefixes, list) and raw_prefixes:
        exposed_prefixes = tuple(
            p.strip() for p in raw_prefixes if isinstance(p, str) and p.strip()
        )
    else:
        exposed_prefixes = EXPOSED_TOOL_PREFIXES_DEFAULT

    if not endpoint or not agent_id:
        print("ERROR: endpoint and agent_id are required", file=sys.stderr)
        return 1
    if not user_prompt:
        print("ERROR: user_prompt is required", file=sys.stderr)
        return 1
    if not mcp_server_url:
        print("ERROR: mcp_server_url is required", file=sys.stderr)
        return 1
    if not card_id:
        print("ERROR: card_id is required", file=sys.stderr)
        return 1

    try:
        from azure.identity import DefaultAzureCredential
        from azure.ai.agents import AgentsClient
        from azure.ai.agents.models import MessageRole, ToolOutput
    except ImportError as e:
        print(
            f"ERROR: Missing package: {e.name}. "
            "Install with: pip install -r demo-board/server/chat-flow/foundry-chat/requirements.txt",
            file=sys.stderr,
        )
        return 1

    _emit({"stage": "connect-mcp", "url": mcp_server_url, "exposed_prefixes": list(exposed_prefixes)})
    try:
        tools_meta = asyncio.run(_list_mcp_tools(mcp_server_url, exposed_prefixes))
    except Exception as e:
        print(f"ERROR: failed to list MCP tools: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return 1
    _emit({"stage": "tools-discovered", "count": len(tools_meta)})

    function_tools, name_map = _build_function_tools(tools_meta)

    credential = DefaultAzureCredential()
    client = AgentsClient(endpoint=endpoint, credential=credential)

    thread_id = _resolve_thread_id(client, existing_thread_id)
    _emit({"stage": "thread-resolved", "thread_id": thread_id, "card_id": card_id})

    # Post the user message for this turn.
    client.messages.create(
        thread_id=thread_id,
        role=MessageRole.USER,
        content=user_prompt,
    )

    run = client.runs.create(
        thread_id=thread_id,
        agent_id=agent_id,
        additional_instructions=system_instructions,
        tools=function_tools,
    )
    _emit({"stage": "run-started", "run_id": run.id})

    deadline = time.time() + timeout_seconds
    final_reply_staged = False
    safety_iters = 0
    max_iters = 64

    while True:
        if time.time() > deadline:
            print(f"ERROR: run {run.id} exceeded timeout_seconds={timeout_seconds}", file=sys.stderr)
            return 1
        safety_iters += 1
        if safety_iters > max_iters:
            print(f"ERROR: run {run.id} exceeded max_iters={max_iters}", file=sys.stderr)
            return 1

        if run.status in ("queued", "in_progress"):
            time.sleep(1)
            run = client.runs.get(thread_id=thread_id, run_id=run.id)
            continue

        if run.status == "requires_action":
            action = run.required_action
            tool_calls = action.submit_tool_outputs.tool_calls
            outputs = []
            stage_reply_succeeded = False
            for tc in tool_calls:
                fn_name = tc.function.name
                real_name = name_map.get(fn_name, fn_name)
                try:
                    fn_args = json.loads(tc.function.arguments) if tc.function.arguments else {}
                except Exception:
                    fn_args = {}
                fn_args = _merge_liveboards_runtime_handles(
                    real_name,
                    fn_args,
                    board_id=board_id,
                    card_id=card_id,
                    log_id=log_id,
                    turn_id=turn_id,
                )
                _emit({"stage": "tool-call", "name": real_name, "args_preview": str(fn_args)[:300]})
                try:
                    result_text = asyncio.run(_call_mcp_tool(mcp_server_url, real_name, fn_args))
                except Exception as e:
                    result_text = json.dumps({"error": f"{real_name} failed: {e}"})
                if real_name == "liveboards.stage-ai-response-and-any-attachments":
                    # Parse the result to confirm success before flagging.
                    try:
                        parsed = json.loads(result_text)
                        if isinstance(parsed, dict) and parsed.get("status") == "success":
                            final_reply_staged = True
                            stage_reply_succeeded = True
                    except Exception:
                        pass
                outputs.append(ToolOutput(tool_call_id=tc.id, output=result_text))

            run = client.runs.submit_tool_outputs(
                thread_id=thread_id,
                run_id=run.id,
                tool_outputs=outputs,
            )
            if stage_reply_succeeded:
                _emit({
                    "stage": "final-reply-staged",
                    "run_id": run.id,
                    "thread_id": thread_id,
                    "terminating_after_stage": True,
                })
                _cancel_run_if_active(client, thread_id, run.id)
                return 0
            continue

        if run.status == "completed":
            _emit({"stage": "run-completed", "run_id": run.id, "final_reply_staged": final_reply_staged})
            if not final_reply_staged:
                # Agent finished without calling the staging tool — surface the
                # last assistant message via the staging tool ourselves so the
                # SPA receives a reply.
                try:
                    last = client.messages.get_last_message_text_by_role(thread_id=thread_id, role="assistant")
                    text_value = last.text.value if last and getattr(last, "text", None) else ""
                except Exception:
                    text_value = ""
                if text_value.strip():
                    args = {
                        "board_id": board_id,
                        "card_id": card_id,
                        "turn_id": turn_id,
                        "text": text_value.strip(),
                        "files": [],
                        "log_id": log_id,
                    }
                    try:
                        asyncio.run(_call_mcp_tool(
                            mcp_server_url,
                            "liveboards.stage-ai-response-and-any-attachments",
                            args,
                        ))
                        final_reply_staged = True
                    except Exception as e:
                        print(f"ERROR: fallback stage-ai-response failed: {e}", file=sys.stderr)
                        return 1
                else:
                    print("ERROR: run completed but no assistant text was produced", file=sys.stderr)
                    return 1
            return 0

        # failed / cancelled / expired / unknown
        last_err = getattr(run, "last_error", None)
        print(f"ERROR: run {run.id} ended with status={run.status} last_error={last_err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
