"""
Agent Schedule Generator - Google Cloud Function
Claude API Proxy for AI-powered scheduling
"""

import os
import json
import functions_framework
from flask import jsonify, make_response
import anthropic

# 讀取 API Key（優先從 agentConfig.py，fallback 到環境變數）
try:
    from agentConfig import ANTHROPIC_API_KEY
except ImportError:
    ANTHROPIC_API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')

# CORS 白名單
ALLOWED_ORIGINS = [
    'https://bol-line-bot-3.web.app',
    'https://bol-line-bot-3.firebaseapp.com',
    'http://localhost:5000',   # 本地開發
    'http://127.0.0.1:5000',
]

def cors_response(data=None, status=200):
    """建立帶 CORS header 的回應"""
    if isinstance(data, dict):
        response = make_response(jsonify(data), status)
    else:
        response = make_response(data or '', status)
    return response

def add_cors_headers(response, origin):
    """加入 CORS headers"""
    if origin in ALLOWED_ORIGINS:
        response.headers['Access-Control-Allow-Origin'] = origin
    response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    response.headers['Access-Control-Max-Age'] = '3600'
    return response


# Claude Tool 定義：限制回傳 scheduleData 格式
SCHEDULE_TOOL = {
    "name": "update_schedule",
    "description": "更新排班表。請使用此工具回傳新的排班資料。每個日期的每個服事項目都是一個人名陣列。",
    "input_schema": {
        "type": "object",
        "properties": {
            "scheduleData": {
                "type": "array",
                "description": "排班資料陣列，每個元素代表一週",
                "items": {
                    "type": "object",
                    "properties": {
                        "date": {
                            "type": "string",
                            "description": "日期字串，格式如 '2026-03-29'"
                        }
                    },
                    "additionalProperties": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "服事項目對應的人名陣列"
                    },
                    "required": ["date"]
                }
            },
            "explanation": {
                "type": "string",
                "description": "簡短說明排班邏輯和考量"
            }
        },
        "required": ["scheduleData", "explanation"]
    }
}


@functions_framework.http
def generate_agent_schedule(request):
    """HTTP Cloud Function 入口"""
    origin = request.headers.get('Origin', '')

    # 處理 CORS preflight
    if request.method == 'OPTIONS':
        response = cors_response('', 204)
        return add_cors_headers(response, origin)

    # 檢查來源
    if origin and origin not in ALLOWED_ORIGINS:
        response = cors_response({'error': 'Forbidden origin'}, 403)
        return add_cors_headers(response, origin)

    # 只接受 POST
    if request.method != 'POST':
        response = cors_response({'error': 'Method not allowed'}, 405)
        return add_cors_headers(response, origin)

    try:
        data = request.get_json(force=True)
    except Exception:
        response = cors_response({'error': 'Invalid JSON'}, 400)
        return add_cors_headers(response, origin)

    # 取得參數
    prompt = data.get('prompt', '')
    current_schedule = data.get('currentSchedule', '{}')
    selected_model = data.get('selectedModel', 'claude-sonnet-4-6')
    active_rules = data.get('activeRules', {})
    attached_csv_text = data.get('attachedCsvText', '')

    if not prompt:
        response = cors_response({'error': 'Missing prompt'}, 400)
        return add_cors_headers(response, origin)

    # 取得 API Key
    if not ANTHROPIC_API_KEY:
        response = cors_response({'error': 'API key not configured'}, 500)
        return add_cors_headers(response, origin)

    # 建立 System Prompt
    system_prompt = build_system_prompt(current_schedule, active_rules, attached_csv_text)

    try:
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

        # 呼叫 Claude API
        message = client.messages.create(
            model=selected_model,
            max_tokens=8192,
            system=system_prompt,
            tools=[SCHEDULE_TOOL],
            tool_choice={"type": "tool", "name": "update_schedule"},
            messages=[
                {"role": "user", "content": prompt}
            ]
        )

        # 從 tool_use 回應中取出結果
        result = None
        explanation = ''
        for content_block in message.content:
            if content_block.type == 'tool_use' and content_block.name == 'update_schedule':
                result = content_block.input.get('scheduleData', [])
                explanation = content_block.input.get('explanation', '')
                break

        if result is None:
            response = cors_response({'error': 'No schedule data in response'}, 500)
            return add_cors_headers(response, origin)

        response = cors_response({
            'scheduleData': result,
            'explanation': explanation,
            'model': selected_model,
            'usage': {
                'input_tokens': message.usage.input_tokens,
                'output_tokens': message.usage.output_tokens
            }
        })
        return add_cors_headers(response, origin)

    except anthropic.APIError as e:
        response = cors_response({'error': f'Claude API error: {str(e)}'}, 502)
        return add_cors_headers(response, origin)
    except Exception as e:
        response = cors_response({'error': f'Internal error: {str(e)}'}, 500)
        return add_cors_headers(response, origin)


def build_system_prompt(current_schedule, active_rules, attached_csv_text):
    """建立給 Claude 的 System Prompt"""
    rules_text = ''
    if active_rules.get('consecutive'):
        rules_text += '\n- 禁止同一人連續兩週（相鄰日期）擔任相同服事項目'
    if active_rules.get('maxRoles'):
        rules_text += '\n- 單一使用者在同一週內最多擔任 3 項服事'

    csv_section = ''
    if attached_csv_text:
        csv_section = f"""

## 使用者提供的參考資料 (CSV)
以下是使用者上傳的 CSV 資料，請參考此資料來排班：
<csv_data>
{attached_csv_text}
</csv_data>
"""

    rules_section = rules_text if rules_text else '\n- (無特定規則限制)'

    return f"""你是一個教會排班助手 AI。你的工作是根據使用者的指示，修改或產生排班表資料。

## 當前排班表（JSON 格式）
```json
{current_schedule}
```

## 排班規則
以下是必須遵守的排班規則：{rules_section}
{csv_section}
## 重要提示
1. 你必須使用 `update_schedule` 工具回傳完整的排班資料。
2. 回傳的 `scheduleData` 中的每個物件必須包含 `date` 欄位和各服事項目欄位。
3. 服事項目的值必須是人名字串陣列（例如 ["小明", "小華"]）。
4. 保持日期欄位和服事項目欄位名稱與原始資料一致。
5. 請仔細遵守排班規則，不要讓任何人違反規則。
6. 如果使用者只要求修改部分內容，請保持其他部分不變。
7. 在 `explanation` 中簡短說明你的排班邏輯。"""
