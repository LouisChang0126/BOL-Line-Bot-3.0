"""
Agent Schedule Generator - Google Cloud Function
Supports mode-based provider routing:
- anthropic
- openai_compatible
"""

import json
import os
import random
import time

import anthropic
import functions_framework
import requests
from flask import jsonify, make_response

try:
    from agentConfig import MODE_CONFIG, DEFAULT_MODE, ALLOWED_ORIGINS
except ImportError:
    MODE_CONFIG = {
        "edit_qa": {
            "provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "api_base_url": "",
            "api_key": os.environ.get("ANTHROPIC_API_KEY", ""),
        },
        "scheduling": {
            "provider": "anthropic",
            "model": "claude-opus-4-6",
            "api_base_url": "",
            "api_key": os.environ.get("ANTHROPIC_API_KEY", ""),
        },
    }
    DEFAULT_MODE = "edit_qa"
    ALLOWED_ORIGINS = ["https://bol-line-bot-3.web.app"]

SCHEDULE_TOOL = {
    "name": "update_schedule",
    "description": "Update schedule JSON. If user only asks a question, respond normally without tool call.",
    "input_schema": {
        "type": "object",
        "properties": {
            "scheduleData": {
                "type": "array",
                "description": "Full schedule rows after modification.",
                "items": {
                    "type": "object",
                    "properties": {
                        "date": {
                            "type": "string",
                            "description": "Date string, e.g. 2026-03-29",
                        }
                    },
                    "additionalProperties": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "required": ["date"],
                },
            },
            "addWeeks": {
                "type": "integer",
                "description": "How many weeks to append structurally.",
            },
            "removeWeeks": {
                "type": "integer",
                "description": "How many weeks to remove structurally.",
            },
            "addServiceColumns": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Service columns to add structurally.",
            },
            "removeServiceColumns": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Service columns to remove structurally.",
            },
            "explanation": {
                "type": "string",
                "description": "Short explanation for the user.",
            },
        },
        "required": ["scheduleData", "explanation"],
    },
}


def cors_response(data=None, status=200):
    if isinstance(data, dict):
        return make_response(jsonify(data), status)
    return make_response(data or "", status)


def add_cors_headers(response, origin):
    if origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
    response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Max-Age"] = "3600"
    return response


def _resolve_mode_config(selected_mode):
    mode = selected_mode or DEFAULT_MODE
    cfg = MODE_CONFIG.get(mode) or MODE_CONFIG.get(DEFAULT_MODE, {})
    return mode, cfg


def _build_messages(chat_history, prompt):
    messages = []
    for msg in chat_history:
        role = msg.get("role", "user")
        if role not in ("user", "assistant"):
            role = "user"
        messages.append({
            "role": role,
            "content": msg.get("content", ""),
        })
    messages.append({"role": "user", "content": prompt})
    return messages


def _anthropic_chat(api_key, model, system_prompt, messages):
    client = anthropic.Anthropic(api_key=api_key)
    max_retries = 3
    retryable_status_codes = {429, 500, 502, 503, 504, 529}
    last_error = None
    message = None

    for attempt in range(max_retries):
        try:
            message = client.messages.create(
                model=model,
                max_tokens=8192,
                system=system_prompt,
                tools=[SCHEDULE_TOOL],
                tool_choice={"type": "auto"},
                messages=messages,
            )
            break
        except anthropic.APIError as err:
            last_error = err
            status_code = getattr(err, "status_code", None)
            message_text = str(err).lower()
            is_retryable = (
                status_code in retryable_status_codes
                or "internal server error" in message_text
                or "temporarily unavailable" in message_text
                or "overloaded" in message_text
            )
            if (not is_retryable) or attempt == max_retries - 1:
                raise

            backoff_seconds = (1.2 * (2 ** attempt)) + random.uniform(0, 0.4)
            time.sleep(backoff_seconds)

    if message is None:
        raise last_error

    tool_input = None
    text_parts = []
    for block in message.content:
        block_type = getattr(block, "type", None)
        if block_type == "tool_use" and getattr(block, "name", "") == "update_schedule":
            tool_input = getattr(block, "input", None) or {}
            break
        if block_type == "text":
            text_parts.append(getattr(block, "text", ""))

    usage = {
        "input_tokens": getattr(getattr(message, "usage", None), "input_tokens", 0),
        "output_tokens": getattr(getattr(message, "usage", None), "output_tokens", 0),
    }
    return tool_input, "\n".join([t for t in text_parts if t]).strip(), usage


def _openai_compatible_chat(api_base_url, api_key, model, system_prompt, messages):
    if not api_base_url:
        raise ValueError("api_base_url is required for openai_compatible provider")

    endpoint = f"{api_base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    oa_messages = [{"role": "system", "content": system_prompt}] + messages
    payload = {
        "model": model,
        "messages": oa_messages,
        "tools": [{
            "type": "function",
            "function": {
                "name": SCHEDULE_TOOL["name"],
                "description": SCHEDULE_TOOL["description"],
                "parameters": SCHEDULE_TOOL["input_schema"],
            },
        }],
        "tool_choice": "auto",
    }

    response = requests.post(endpoint, headers=headers, json=payload, timeout=120)
    if response.status_code >= 400:
        raise RuntimeError(f"OpenAI-compatible API error ({response.status_code}): {response.text}")

    data = response.json()
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("OpenAI-compatible API returned no choices")

    message = (choices[0] or {}).get("message", {})
    tool_calls = message.get("tool_calls") or []
    tool_input = None
    for call in tool_calls:
        fn = (call or {}).get("function") or {}
        if fn.get("name") != "update_schedule":
            continue
        raw_args = fn.get("arguments", "{}")
        if isinstance(raw_args, str):
            try:
                tool_input = json.loads(raw_args or "{}")
            except json.JSONDecodeError:
                tool_input = {}
        elif isinstance(raw_args, dict):
            tool_input = raw_args
        else:
            tool_input = {}
        break

    usage_raw = data.get("usage") or {}
    usage = {
        "input_tokens": usage_raw.get("prompt_tokens", 0),
        "output_tokens": usage_raw.get("completion_tokens", 0),
    }
    return tool_input, (message.get("content") or "").strip(), usage


@functions_framework.http
def generate_agent_schedule(request):
    origin = request.headers.get("Origin", "")

    if request.method == "OPTIONS":
        return add_cors_headers(cors_response("", 204), origin)

    if origin and origin not in ALLOWED_ORIGINS:
        return add_cors_headers(cors_response({"error": "Forbidden origin"}, 403), origin)

    if request.method != "POST":
        return add_cors_headers(cors_response({"error": "Method not allowed"}, 405), origin)

    try:
        data = request.get_json(force=True)
    except Exception:
        return add_cors_headers(cors_response({"error": "Invalid JSON"}, 400), origin)

    prompt = data.get("prompt", "")
    current_schedule = data.get("currentSchedule", "{}")
    selected_mode = data.get("selectedMode", DEFAULT_MODE)
    active_rules = data.get("activeRules", {})
    attached_csv_text = data.get("attachedCsvText", "")
    chat_history = data.get("chatHistory", [])

    if not prompt:
        return add_cors_headers(cors_response({"error": "Missing prompt"}, 400), origin)

    mode, mode_cfg = _resolve_mode_config(selected_mode)
    provider = mode_cfg.get("provider", "anthropic")
    model = mode_cfg.get("model", "claude-sonnet-4-6")
    api_base_url = mode_cfg.get("api_base_url", "")
    api_key = mode_cfg.get("api_key", "")

    system_prompt = build_system_prompt(
        current_schedule,
        active_rules,
        attached_csv_text,
        selected_mode=mode,
    )
    messages = _build_messages(chat_history, prompt)

    try:
        if provider == "anthropic":
            if not api_key:
                return add_cors_headers(cors_response({"error": "API key not configured for anthropic mode"}, 500), origin)
            tool_input, text_response, usage = _anthropic_chat(api_key, model, system_prompt, messages)
        elif provider == "openai_compatible":
            tool_input, text_response, usage = _openai_compatible_chat(api_base_url, api_key, model, system_prompt, messages)
        else:
            return add_cors_headers(cors_response({"error": f"Unsupported provider: {provider}"}, 500), origin)

        if not tool_input:
            answer_text = text_response or "目前無需修改排班，這題以問答模式回覆。"
            response = cors_response({
                "mode": "answer_only",
                "answerOnly": True,
                "answer": answer_text,
                "explanation": answer_text,
                "modeKey": mode,
                "provider": provider,
                "model": model,
                "usage": usage,
            })
            return add_cors_headers(response, origin)

        result = tool_input.get("scheduleData", [])
        explanation = tool_input.get("explanation", "")
        if not result:
            return add_cors_headers(cors_response({"error": "No schedule data in response"}, 500), origin)

        response = cors_response({
            "scheduleData": result,
            "explanation": explanation,
            "addWeeks": tool_input.get("addWeeks", 0),
            "removeWeeks": tool_input.get("removeWeeks", 0),
            "addServiceColumns": tool_input.get("addServiceColumns", []),
            "removeServiceColumns": tool_input.get("removeServiceColumns", []),
            "modeKey": mode,
            "provider": provider,
            "model": model,
            "usage": usage,
        })
        return add_cors_headers(response, origin)

    except anthropic.APIError as e:
        return add_cors_headers(cors_response({"error": f"Claude API error: {str(e)}"}, 502), origin)
    except Exception as e:
        return add_cors_headers(cors_response({"error": f"Internal error: {str(e)}"}, 500), origin)


def build_system_prompt(current_schedule, active_rules, attached_csv_text, selected_mode):
    is_scheduling = selected_mode == "scheduling"

    rules = []
    rules_section = ""
    if is_scheduling:
        consecutive_weeks = max(2, int(active_rules.get("consecutiveWeeks", 2) or 2))
        max_roles_limit = max(1, int(active_rules.get("maxRolesLimit", 3) or 3))

        if active_rules.get("consecutive"):
            rules.append(
                f"- Do not assign the same person in the same service for {consecutive_weeks} consecutive weeks."
            )
        if active_rules.get("maxRoles"):
            rules.append(f"- Each person should not exceed {max_roles_limit} service roles per week.")
        if active_rules.get("serviceKnownPeople"):
            rules.append("- For each service, only use people who have appeared in that service historically.")
        if not rules:
            rules.append("- No extra scheduling rules are enabled.")
        rules_section = (
            "## Active Rules\n"
            f"{os.linesep.join(rules)}\n\n"
        )
    else:
        rules_section = ""

    csv_section = ""
    if (not is_scheduling) and attached_csv_text:
        csv_section = (
            "\n\n## CSV Availability Data\n"
            "Use this data as constraints/reference when editing the schedule.\n"
            "<csv_data>\n"
            f"{attached_csv_text}\n"
            "</csv_data>\n"
        )

    return (
        "You are a schedule editing assistant.\n"
        "If the user asks for scheduling changes, call tool `update_schedule`.\n"
        "If the user asks a pure question, answer directly without tool call.\n\n"
        "## Current Schedule JSON\n"
        "```json\n"
        f"{current_schedule}\n"
        "```\n\n"
        f"{rules_section}"
        f"{csv_section}\n"
        "## Tool Requirements\n"
        "1. Always return complete `scheduleData` when calling the tool.\n"
        "2. Use `addWeeks`/`removeWeeks` only for structural week changes.\n"
        "3. Use `addServiceColumns`/`removeServiceColumns` for structural service changes.\n"
        "4. Keep each row with a `date` field and service arrays of names.\n"
        "5. Include a concise `explanation`.\n"
    )
